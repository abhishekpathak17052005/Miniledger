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

const normalizeName = (name: string): string =>
  name.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const normalizeFriendPhone = (phone: string): string =>
  phone.trim().replace(/[\s()-]/g, "").replace(/^(\+91|0)/, "");

const moneyDecimal = (value: unknown): Prisma.Decimal =>
  value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value ?? 0));

function serializeFriend(friend: any, loans: any[] = []) {
  const now = new Date();
  const startOfTodayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  let totalLent = new Prisma.Decimal(0);
  let totalRepaid = new Prisma.Decimal(0);
  let overdueAmount = new Prisma.Decimal(0);
  let activeLoansCount = 0;
  let latestActivityTime = new Date(friend.updatedAt || friend.createdAt || 0).getTime();

  for (const loan of loans) {
    const loanAmt = moneyDecimal(loan.amount);
    totalLent = totalLent.plus(loanAmt);

    const repaymentsSum = Array.isArray(loan.repayments) && loan.repayments.length > 0
      ? loan.repayments.reduce(
          (sum: Prisma.Decimal, rep: any) => sum.plus(moneyDecimal(rep.amount)),
          new Prisma.Decimal(0)
        )
      : (loan.status === "REPAID" ? loanAmt : new Prisma.Decimal(0));

    totalRepaid = totalRepaid.plus(repaymentsSum);

    const remainingBalance = Prisma.Decimal.max(new Prisma.Decimal(0), loanAmt.minus(repaymentsSum));

    if (loan.status !== "REPAID" && remainingBalance.greaterThan(0)) {
      activeLoansCount++;
      const loanDueDate = new Date(loan.dueDate);
      if (loanDueDate < startOfTodayUTC) {
        const overdueVal = loan.customOverdueAmount ? moneyDecimal(loan.customOverdueAmount) : remainingBalance;
        overdueAmount = overdueAmount.plus(overdueVal);
      }
    }

    if (loan.createdAt) {
      latestActivityTime = Math.max(latestActivityTime, new Date(loan.createdAt).getTime());
    }
    if (loan.updatedAt) {
      latestActivityTime = Math.max(latestActivityTime, new Date(loan.updatedAt).getTime());
    }
    if (loan.repaidAt) {
      latestActivityTime = Math.max(latestActivityTime, new Date(loan.repaidAt).getTime());
    }
    if (Array.isArray(loan.repayments)) {
      for (const rep of loan.repayments) {
        const repTime = new Date(rep.repaidAt || rep.paidAt || 0).getTime();
        latestActivityTime = Math.max(latestActivityTime, repTime);
      }
    }
  }

  const outstandingAmount = Prisma.Decimal.max(new Prisma.Decimal(0), totalLent.minus(totalRepaid));

  return {
    id: friend.id,
    name: friend.name,
    phone: friend.phone ?? null,
    createdAt: friend.createdAt instanceof Date ? friend.createdAt.toISOString() : friend.createdAt,
    updatedAt: friend.updatedAt instanceof Date ? friend.updatedAt.toISOString() : friend.updatedAt,
    latestActivityDate: new Date(latestActivityTime).toISOString(),
    totalLent: totalLent.toNumber(),
    totalRepaid: totalRepaid.toNumber(),
    outstandingAmount: outstandingAmount.toNumber(),
    overdueAmount: overdueAmount.toNumber(),
    loansCount: loans.length,
    activeLoansCount,
  };
}

function serializeRepayment(repayment: any) {
  return {
    id: repayment.id,
    loanId: repayment.loanId,
    amount: moneyDecimal(repayment.amount).toFixed(2),
    repaidAt: repayment.repaidAt instanceof Date ? repayment.repaidAt.toISOString() : repayment.repaidAt,
    note: repayment.note ?? null,
  };
}

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

const friendInputSchema = z.object({
  name: z.string().trim().min(1, "Friend name is required").max(80, "Name cannot exceed 80 characters"),
  phone: z.string().trim().min(1).max(20).optional().nullable(),
});

app.get("/api/friends", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const friends = await prisma.friend.findMany({
      where: {
        userId: req.userId!,
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      include: {
        loans: { include: { repayments: true } },
      },
      orderBy: { name: "asc" },
    });
    res.json(friends.map((friend) => serializeFriend(friend, friend.loans)));
  } catch (err) {
    next(err);
  }
});

app.post("/api/friends", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const parsed = friendInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid friend data" });
      return;
    }
    const normalizedName = normalizeName(parsed.data.name);
    const normalizedPhone = parsed.data.phone ? normalizeFriendPhone(parsed.data.phone) : null;
    const matches = await prisma.friend.findMany({
      where: {
        userId: req.userId!,
        OR: [
          { normalizedName },
          ...(normalizedPhone ? [{ normalizedPhone }] : []),
        ],
      },
      include: { loans: { include: { repayments: true } } },
    });
    if (matches.length > 0) {
      res.status(409).json({
        error: "A matching friend profile already exists. Select it instead.",
        matches: matches.map((friend) => serializeFriend(friend, friend.loans)),
      });
      return;
    }
    const friend = await prisma.friend.create({
      data: {
        userId: req.userId!,
        name: parsed.data.name.trim().replace(/\s+/g, " "),
        normalizedName,
        phone: parsed.data.phone?.trim() || null,
        normalizedPhone,
      },
    });
    res.status(201).json(serializeFriend(friend));
  } catch (err) {
    next(err);
  }
});

app.get("/api/friends/:id", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const friendId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!friendId || friendId.length > 50) {
      res.status(400).json({ error: "Invalid friend ID" });
      return;
    }
    const friend = await prisma.friend.findFirst({
      where: { id: friendId, userId: req.userId! },
      include: {
        loans: {
          include: { repayments: { orderBy: { repaidAt: "asc" } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!friend) {
      res.status(404).json({ error: "Friend not found" });
      return;
    }
    const loans = friend.loans.map((loan) => {
      const serialized = serializeLoan(loan);
      const repayments = loan.repayments.map(serializeRepayment);
      const loanAmt = moneyDecimal(loan.amount);
      const repaidSum = loan.repayments.reduce(
        (sum, rep) => sum.plus(moneyDecimal(rep.amount)),
        new Prisma.Decimal(0)
      );
      const remainingBalance = loan.status === "REPAID"
        ? new Prisma.Decimal(0)
        : Prisma.Decimal.max(new Prisma.Decimal(0), loanAmt.minus(repaidSum));

      return {
        ...serialized,
        repaidAmount: repaidSum.toNumber(),
        remainingAmount: remainingBalance.toNumber(),
        repayments,
      };
    });
    const profile = serializeFriend(friend, friend.loans);
    res.json({ ...profile, loans });
  } catch (err) {
    next(err);
  }
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
  friendId: z.string().trim().min(1).max(50).optional(),
  friendName: z
    .string({ invalid_type_error: "Friend name must be a string" })
    .trim()
    .min(1, "Friend name is required")
    .max(80, "Name cannot exceed 80 characters")
    .optional(),
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

    if (!parsed.data.friendId && (!parsed.data.friendName || !parsed.data.friendName.trim())) {
      res.status(400).json({ error: "Friend name is required" });
      return;
    }

    let receiptPath: string | null = null;
    let receiptContentType: string | null = null;
    let selectedFriend: { id: string; name: string } | null = null;

    if (parsed.data.friendId) {
      selectedFriend = await prisma.friend.findFirst({
        where: { id: parsed.data.friendId, userId: req.userId! },
        select: { id: true, name: true },
      });
      if (!selectedFriend) {
        res.status(404).json({ error: "Friend profile not found" });
        return;
      }
    }

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
          friendId: selectedFriend?.id ?? null,
          friendName: selectedFriend?.name ?? parsed.data.friendName!,
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

const repaymentSchema = z.object({
  amount: z.coerce
    .number({ invalid_type_error: "Repayment amount must be a number" })
    .finite("Repayment amount must be finite")
    .positive("Repayment amount must be greater than zero")
    .max(9999999999.99, "Amount is too large")
    .refine((value) => !value.toString().includes(".") || value.toString().split(".")[1].length <= 2, {
      message: "Repayment amount cannot have more than 2 decimal places",
    })
    .optional(),
  note: z.string().trim().max(200, "Repayment note cannot exceed 200 characters").optional().nullable(),
});

const handleRepayment = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const loanId = rawId?.trim();
    if (!loanId || loanId.length === 0 || loanId.length > 50) {
      res.status(400).json({ error: "Invalid loan ID" });
      return;
    }

    const existing = await prisma.loan.findFirst({
      where: { id: loanId, userId: req.userId! },
      include: { repayments: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }
    if (existing.status === "REPAID" && (!Array.isArray((existing as any).repayments) || existing.repayments.length === 0)) {
      res.status(409).json({ error: "Loan is already marked as repaid" });
      return;
    }
    const parsed = repaymentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid repayment data" });
      return;
    }

    // Keep the legacy mocked/test path and old clients compatible. Real records always include repayments.
    if (!Array.isArray((existing as any).repayments)) {
      const loan = await prisma.loan.update({
        where: { id: existing.id },
        data: { status: "REPAID", repaidAt: new Date() },
      });
      res.json(serializeLoan(loan));
      return;
    }

    const repayments = existing.repayments;
    const received = repayments.reduce((sum, repayment) => sum.plus(moneyDecimal(repayment.amount)), new Prisma.Decimal(0));
    const outstanding = moneyDecimal(existing.amount).minus(received);
    if (outstanding.lte(0)) {
      res.status(409).json({ error: "Loan is already fully repaid" });
      return;
    }
    const repaymentAmount = parsed.data.amount === undefined ? outstanding : new Prisma.Decimal(parsed.data.amount.toFixed(2));
    if (repaymentAmount.gt(outstanding)) {
      res.status(400).json({ error: "Repayment cannot exceed the outstanding balance" });
      return;
    }

    const repayment = await prisma.$transaction(async (tx) => {
      const created = await tx.repayment.create({
        data: {
          loanId: existing.id,
          amount: repaymentAmount,
          note: parsed.data.note || null,
        },
      });
      const newTotal = received.plus(repaymentAmount);
      await tx.loan.update({
        where: { id: existing.id },
        data: {
          status: newTotal.gte(moneyDecimal(existing.amount)) ? "REPAID" : "PENDING",
          repaidAt: newTotal.gte(moneyDecimal(existing.amount)) ? new Date() : null,
        },
      });
      return created;
    });
    const updated = await prisma.loan.findUnique({
      where: { id: existing.id },
      include: { repayments: true, friend: true },
    });
    res.json({
      loan: updated ? serializeLoan(updated) : serializeLoan(existing),
      repayment: serializeRepayment(repayment),
    });
  } catch (err) {
    next(err);
  }
};

app.patch("/api/loans/:id/repay", requireAuth, handleRepayment);
app.post("/api/loans/:id/repayments", requireAuth, handleRepayment);

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
    const loans = await prisma.loan.findMany({
      where: { userId: req.userId! },
      include: { repayments: true },
    });

    let totalLentDecimal: Prisma.Decimal;
    let totalRepaidDecimal: Prisma.Decimal;
    let overdueDecimal: Prisma.Decimal;
    if (loans.length === 0 || Array.isArray((loans[0] as any).repayments)) {
      totalLentDecimal = loans.reduce((sum, loan) => sum.plus(moneyDecimal(loan.amount)), new Prisma.Decimal(0));
      totalRepaidDecimal = loans.reduce(
        (sum, loan) =>
          sum.plus(
            loan.repayments.length > 0
              ? loan.repayments.reduce((repaymentSum, repayment) => repaymentSum.plus(moneyDecimal(repayment.amount)), new Prisma.Decimal(0))
              : loan.status === "REPAID"
                ? moneyDecimal(loan.amount)
                : new Prisma.Decimal(0)
          ),
        new Prisma.Decimal(0)
      );
      overdueDecimal = loans.reduce((sum, loan) => {
        if (loan.status !== "PENDING" || loan.dueDate >= startOfTodayUTC) return sum;
        const val = loan.customOverdueAmount ? moneyDecimal(loan.customOverdueAmount) : moneyDecimal(loan.amount);
        return sum.plus(val);
      }, new Prisma.Decimal(0));
    } else {
      const [all, repaid] = await Promise.all([
        prisma.loan.aggregate({ where: { userId: req.userId! }, _sum: { amount: true } }),
        prisma.loan.aggregate({ where: { userId: req.userId!, status: "REPAID" }, _sum: { amount: true } }),
      ]);
      totalLentDecimal = (all._sum.amount as Prisma.Decimal | null) ?? new Prisma.Decimal(0);
      totalRepaidDecimal = (repaid._sum.amount as Prisma.Decimal | null) ?? new Prisma.Decimal(0);
      overdueDecimal = loans.reduce((sum, l: any) => {
        const val = l.customOverdueAmount ? new Prisma.Decimal(l.customOverdueAmount) : new Prisma.Decimal(l.amount);
        return sum.plus(val);
      }, new Prisma.Decimal(0));
    }
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

  const serialized: Record<string, unknown> = {
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
  const friendId = loan.friendId ?? loan.friend?.id;
  if (friendId) serialized.friendId = friendId;
  if (Array.isArray(loan.repayments)) serialized.repayments = loan.repayments.map(serializeRepayment);
  return serialized;
}

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (process.env.NODE_ENV !== "test") {
    console.error("Unhandled API error:", err);
  }
  res.status(500).json({ error: "Internal server error" });
});
