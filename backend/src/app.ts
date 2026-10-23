import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { requireAuth, signToken, type AuthRequest } from "./auth.js";

export const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

import { requestOtp, verifyOtp, phoneSchema, otpCodeSchema } from "./otp.js";

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

app.get("/api/loans", requireAuth, async (req: AuthRequest, res) => {
  const loans = await prisma.loan.findMany({
    where: { userId: req.userId! },
    orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
  });
  res.json(loans.map(serializeLoan));
});

const createLoanSchema = z.object({
  friendName: z.string().trim().min(1, "Friend name is required").max(80, "Name cannot exceed 80 characters"),
  amount: z.coerce.number().finite().positive("Amount must be greater than zero").max(9999999999.99, "Amount is too large"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD")
    .refine((s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "Enter a valid calendar date"),
});

app.post("/api/loans", requireAuth, async (req: AuthRequest, res) => {
  const parsed = createLoanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid loan data" });
    return;
  }
  const loan = await prisma.loan.create({
    data: {
      userId: req.userId!,
      friendName: parsed.data.friendName,
      amount: parsed.data.amount.toFixed(2),
      dueDate: new Date(`${parsed.data.dueDate}T00:00:00.000Z`),
    },
  });
  res.status(201).json(serializeLoan(loan));
});

app.patch("/api/loans/:id/repay", requireAuth, async (req: AuthRequest, res) => {
  const loanId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
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
});

app.get("/api/loans/summary", requireAuth, async (req: AuthRequest, res) => {
  const today = new Date();
  const startOfTodayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const [all, repaid, overdue] = await Promise.all([
    prisma.loan.aggregate({ where: { userId: req.userId! }, _sum: { amount: true } }),
    prisma.loan.aggregate({ where: { userId: req.userId!, status: "REPAID" }, _sum: { amount: true } }),
    prisma.loan.aggregate({ where: { userId: req.userId!, status: "PENDING", dueDate: { lt: startOfTodayUTC } }, _sum: { amount: true } }),
  ]);

  const totalLent = money(all._sum.amount);
  const totalRepaid = money(repaid._sum.amount);
  const overdueAmount = money(overdue._sum.amount);
  const outstandingAmount = Math.round((totalLent - totalRepaid + Number.EPSILON) * 100) / 100;

  res.json({
    totalLent,
    totalRepaid,
    overdueAmount,
    outstandingAmount,
  });
});

function money(value: { toString(): string } | null): number {
  return Number(value?.toString() ?? "0");
}

function serializeLoan(loan: any) {
  return {
    id: loan.id,
    friendName: loan.friendName,
    amount: loan.amount.toString(),
    dueDate: new Date(loan.dueDate).toISOString().slice(0, 10),
    status: loan.status,
    createdAt: loan.createdAt,
    repaidAt: loan.repaidAt,
  };
}

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API error:", err);
  res.status(500).json({ error: "Internal server error" });
});
