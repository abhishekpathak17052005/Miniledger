import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { requireAuth, signToken, type AuthRequest } from "./auth.js";
import { requestOtp, verifyOtp, phoneSchema, otpCodeSchema } from "./otp.js";
import { receiptStorage, ALLOWED_MIME_TYPES, MAX_RECEIPT_BYTES, isValidBase64, type AllowedMimeType } from "./storage.js";

export const app = express();
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Clean HTTP request logging for development and demo
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== "test") {
      console.info(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "miniledger-api",
    version: "1.0.0",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

const handleRequestOtp = (req: express.Request, res: express.Response) => {
  const parsed = z.object({ phone: phoneSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid phone number" });
    return;
  }
  const result = requestOtp(parsed.data.phone);
  if (!result.success) {
    res.status(result.status).json({
      error: result.error,
      retryAfterSeconds: result.retryAfterSeconds,
    });
    return;
  }
  res.json({
    message: "OTP generated. Check the backend terminal in this demo.",
    expiresInSeconds: result.expiresInSeconds,
  });
};

// POST /api/auth/request-otp (Phase 3 requirement)
app.post("/api/auth/request-otp", handleRequestOtp);

// POST /api/auth/send-otp (Backwards-compatible alias for existing mobile client)
app.post("/api/auth/send-otp", handleRequestOtp);

app.post("/api/auth/verify-otp", async (req, res) => {
  const parsed = z.object({
    phone: phoneSchema,
    otp: otpCodeSchema,
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const { phone, otp } = parsed.data;
  const verification = verifyOtp(phone, otp);
  if (!verification.success) {
    res.status(verification.status).json({ error: verification.error });
    return;
  }

  // Find or create User in Supabase PostgreSQL through Prisma
  const user = await prisma.user.upsert({
    where: { phone },
    update: {},
    create: { phone },
  });

  res.json({
    token: signToken(user.id),
    user: { id: user.id, phone: user.phone },
  });
});

app.get("/api/loans", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const loans = await prisma.loan.findMany({
      where: { userId: req.userId! },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    });
    res.json(loans.map(serializeLoan));
  } catch (err) {
    next(err);
  }
});

const receiptPayloadSchema = z.object({
  imageBase64: z.string({ required_error: "imageBase64 is required" }).min(1, "Image content cannot be empty"),
  contentType: z.enum(ALLOWED_MIME_TYPES, {
    errorMap: () => ({ message: "Only JPEG, PNG, and WebP images are allowed" }),
  }),
});

const createLoanSchema = z.object({
  friendName: z
    .string({ required_error: "Friend name is required", invalid_type_error: "Friend name must be a string" })
    .trim()
    .min(1, "Friend name is required")
    .max(80, "Name cannot exceed 80 characters"),
  amount: z.coerce
    .number({ required_error: "Amount is required", invalid_type_error: "Amount must be a valid number" })
    .finite("Amount must be a finite number")
    .positive("Amount must be greater than zero")
    .max(9999999999.99, "Amount is too large")
    .refine(
      (val) => {
        const str = val.toString();
        const decimals = str.includes(".") ? str.split(".")[1].length : 0;
        return decimals <= 2;
      },
      { message: "Amount cannot have more than 2 decimal places" }
    ),
  dueDate: z
    .string({ required_error: "Due date is required" })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "Enter a valid calendar date"),
  customOverdueAmount: z.coerce
    .number({ invalid_type_error: "Custom overdue amount must be a number" })
    .finite("Custom overdue amount must be finite")
    .nonnegative("Custom overdue amount cannot be negative")
    .max(9999999999.99, "Amount is too large")
    .refine(
      (val) => {
        const str = val.toString();
        const decimals = str.includes(".") ? str.split(".")[1].length : 0;
        return decimals <= 2;
      },
      { message: "Custom overdue amount cannot have more than 2 decimal places" }
    )
    .optional()
    .nullable(),
  receipt: receiptPayloadSchema.optional(),
});

app.post("/api/loans", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const parsed = createLoanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid loan data" });
      return;
    }

    let receiptPath: string | null = null;
    let receiptContentType: string | null = null;

    if (parsed.data.receipt) {
      if (!isValidBase64(parsed.data.receipt.imageBase64)) {
        res.status(400).json({ error: "Invalid Base64 image payload" });
        return;
      }
      const rawBase64 = parsed.data.receipt.imageBase64.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(rawBase64, "base64");
      if (buffer.length === 0) {
        res.status(400).json({ error: "Image content cannot be empty" });
        return;
      }
      if (buffer.length > MAX_RECEIPT_BYTES) {
        res.status(400).json({ error: "Receipt image exceeds maximum size limit of 5MB" });
        return;
      }
      try {
        const fileId = `loan_${Date.now()}`;
        receiptPath = await receiptStorage.save(
          req.userId!,
          fileId,
          buffer,
          parsed.data.receipt.contentType as AllowedMimeType
        );
        receiptContentType = parsed.data.receipt.contentType;
      } catch (err: any) {
        res.status(400).json({ error: err.message || "Invalid receipt image file" });
        return;
      }
    }

    try {
      const loan = await prisma.loan.create({
        data: {
          userId: req.userId!,
          friendName: parsed.data.friendName,
          amount: parsed.data.amount.toFixed(2),
          dueDate: new Date(`${parsed.data.dueDate}T00:00:00.000Z`),
          customOverdueAmount:
            parsed.data.customOverdueAmount !== undefined && parsed.data.customOverdueAmount !== null
              ? parsed.data.customOverdueAmount.toFixed(2)
              : null,
          receiptPath,
          receiptContentType,
        },
      });

      res.status(201).json(serializeLoan(loan));
    } catch (dbErr) {
      if (receiptPath) {
        await receiptStorage.delete(receiptPath).catch(() => {});
      }
      throw dbErr;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/loans/:id/receipt - Attach or replace receipt on an existing loan
app.post("/api/loans/:id/receipt", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const loanId = rawId?.trim();
    if (!loanId || loanId.length === 0 || loanId.length > 50) {
      res.status(400).json({ error: "Invalid loan ID" });
      return;
    }

    const parsed = receiptPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid receipt data" });
      return;
    }

    const existing = await prisma.loan.findFirst({
      where: { id: loanId, userId: req.userId! },
    });

    if (!existing) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    if (!isValidBase64(parsed.data.imageBase64)) {
      res.status(400).json({ error: "Invalid Base64 image payload" });
      return;
    }

    const rawBase64 = parsed.data.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(rawBase64, "base64");
    if (buffer.length === 0) {
      res.status(400).json({ error: "Image content cannot be empty" });
      return;
    }
    if (buffer.length > MAX_RECEIPT_BYTES) {
      res.status(400).json({ error: "Receipt image exceeds maximum size limit of 5MB" });
      return;
    }

    let receiptPath: string;
    try {
      receiptPath = await receiptStorage.save(
        req.userId!,
        existing.id,
        buffer,
        parsed.data.contentType as AllowedMimeType
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Invalid receipt image file" });
      return;
    }

    const oldReceiptPath = existing.receiptPath;
    try {
      const updated = await prisma.loan.update({
        where: { id: existing.id },
        data: {
          receiptPath,
          receiptContentType: parsed.data.contentType,
        },
      });

      if (oldReceiptPath && oldReceiptPath !== receiptPath) {
        await receiptStorage.delete(oldReceiptPath).catch(() => {});
      }

      res.json(serializeLoan(updated));
    } catch (updateErr) {
      await receiptStorage.delete(receiptPath).catch(() => {});
      throw updateErr;
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/loans/:id/receipt - Securely view/download the receipt (owner only)
app.get("/api/loans/:id/receipt", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const loanId = rawId?.trim();
    if (!loanId || loanId.length === 0 || loanId.length > 50) {
      res.status(400).json({ error: "Invalid loan ID" });
      return;
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, userId: req.userId! },
    });

    if (!loan) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    if (!loan.receiptPath) {
      res.status(404).json({ error: "No receipt attached to this loan" });
      return;
    }

    const result = await receiptStorage.get(loan.receiptPath);

    if (result.signedUrl) {
      if (req.query.format === "json") {
        res.json({ url: result.signedUrl, contentType: loan.receiptContentType });
        return;
      }
      res.redirect(result.signedUrl);
      return;
    }

    if (result.buffer) {
      if (req.query.format === "json") {
        const base64 = result.buffer.toString("base64");
        const dataUrl = `data:${loan.receiptContentType || result.mimeType};base64,${base64}`;
        res.json({ url: dataUrl, contentType: loan.receiptContentType || result.mimeType });
        return;
      }
      res.setHeader("Content-Type", loan.receiptContentType || result.mimeType);
      res.setHeader("Cache-Control", "private, no-transform, max-age=3600");
      res.setHeader("Content-Disposition", "inline");
      res.send(result.buffer);
      return;
    }

    res.status(404).json({ error: "Receipt file not found" });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: "Receipt file not found" });
      return;
    }
    next(err);
  }
});

// DELETE /api/loans/:id/receipt - Remove receipt from a loan (owner only)
app.delete("/api/loans/:id/receipt", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const loanId = rawId?.trim();
    if (!loanId || loanId.length === 0 || loanId.length > 50) {
      res.status(400).json({ error: "Invalid loan ID" });
      return;
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, userId: req.userId! },
    });

    if (!loan) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    if (loan.receiptPath) {
      await receiptStorage.delete(loan.receiptPath);
    }

    const updated = await prisma.loan.update({
      where: { id: loan.id },
      data: { receiptPath: null, receiptContentType: null },
    });

    res.json(serializeLoan(updated));
  } catch (err) {
    next(err);
  }
});

app.patch("/api/loans/:id/repay", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const loanId = rawId?.trim();
    if (!loanId || loanId.length === 0 || loanId.length > 50) {
      res.status(400).json({ error: "Invalid loan ID" });
      return;
    }

    const existing = await prisma.loan.findFirst({ where: { id: loanId, userId: req.userId! } });
    if (!existing) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }
    if (existing.status === "REPAID") {
      res.status(409).json({ error: "Loan is already marked as repaid" });
      return;
    }
    const loan = await prisma.loan.update({
      where: { id: existing.id },
      data: { status: "REPAID", repaidAt: new Date() },
    });
    res.json(serializeLoan(loan));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/loans/:id/overdue - Set or clear custom overdue amount
app.patch("/api/loans/:id/overdue", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const loanId = rawId?.trim();
    if (!loanId || loanId.length === 0 || loanId.length > 50) {
      res.status(400).json({ error: "Invalid loan ID" });
      return;
    }

    const schema = z.object({
      customOverdueAmount: z.coerce
        .number({ invalid_type_error: "Custom overdue amount must be a number" })
        .finite("Custom overdue amount must be finite")
        .nonnegative("Custom overdue amount cannot be negative")
        .max(9999999999.99, "Amount is too large")
        .refine(
          (val) => {
            const str = val.toString();
            const decimals = str.includes(".") ? str.split(".")[1].length : 0;
            return decimals <= 2;
          },
          { message: "Custom overdue amount cannot have more than 2 decimal places" }
        )
        .nullable(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid custom overdue amount" });
      return;
    }

    const existing = await prisma.loan.findFirst({
      where: { id: loanId, userId: req.userId! },
    });
    if (!existing) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    const updated = await prisma.loan.update({
      where: { id: existing.id },
      data: {
        customOverdueAmount:
          parsed.data.customOverdueAmount !== null
            ? parsed.data.customOverdueAmount.toFixed(2)
            : null,
      },
    });

    res.json(serializeLoan(updated));
  } catch (err) {
    next(err);
  }
});

app.get("/api/loans/summary", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const today = new Date();
    const startOfTodayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const [all, repaid, overdueLoans] = await Promise.all([
      prisma.loan.aggregate({ where: { userId: req.userId! }, _sum: { amount: true } }),
      prisma.loan.aggregate({ where: { userId: req.userId!, status: "REPAID" }, _sum: { amount: true } }),
      prisma.loan.findMany({
        where: { userId: req.userId!, status: "PENDING", dueDate: { lt: startOfTodayUTC } },
        select: { amount: true, customOverdueAmount: true },
      }),
    ]);

    const totalLentDecimal = (all._sum.amount as Prisma.Decimal | null) ?? new Prisma.Decimal(0);
    const totalRepaidDecimal = (repaid._sum.amount as Prisma.Decimal | null) ?? new Prisma.Decimal(0);
    const overdueDecimal = overdueLoans.reduce((sum, l) => {
      const val = l.customOverdueAmount ? new Prisma.Decimal(l.customOverdueAmount) : new Prisma.Decimal(l.amount);
      return sum.plus(val);
    }, new Prisma.Decimal(0));
    const outstandingDecimal = totalLentDecimal.minus(totalRepaidDecimal);

    res.json({
      totalLent: totalLentDecimal.toNumber(),
      totalRepaid: totalRepaidDecimal.toNumber(),
      overdueAmount: overdueDecimal.toNumber(),
      outstandingAmount: outstandingDecimal.toNumber(),
    });
  } catch (err) {
    next(err);
  }
});

function serializeLoan(loan: any) {
  const amountStr = typeof loan.amount?.toFixed === "function"
    ? loan.amount.toFixed(2)
    : Number(loan.amount ?? 0).toFixed(2);
  const customOverdueStr = loan.customOverdueAmount
    ? (typeof loan.customOverdueAmount?.toFixed === "function"
        ? loan.customOverdueAmount.toFixed(2)
        : Number(loan.customOverdueAmount).toFixed(2))
    : null;

  return {
    id: loan.id,
    friendName: loan.friendName,
    amount: amountStr,
    dueDate: new Date(loan.dueDate).toISOString().slice(0, 10),
    status: loan.status,
    customOverdueAmount: customOverdueStr,
    hasReceipt: Boolean(loan.receiptPath),
    receiptUrl: loan.receiptPath ? `/api/loans/${loan.id}/receipt` : null,
    createdAt: loan.createdAt instanceof Date ? loan.createdAt.toISOString() : loan.createdAt,
    repaidAt: loan.repaidAt ? (loan.repaidAt instanceof Date ? loan.repaidAt.toISOString() : loan.repaidAt) : null,
  };
}

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (process.env.NODE_ENV !== "test") {
    console.error("Unhandled API error:", err);
  }
  res.status(500).json({ error: "Internal server error" });
});
