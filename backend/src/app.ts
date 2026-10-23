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

// Assignment-only OTP store. In production use Redis and a carrier SMS gateway.
const otpStore = new Map<string, { code: string; expiresAt: number; attempts: number }>();
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number");

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "miniledger-api",
    version: "1.0.0",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/auth/send-otp", (req, res) => {
  const parsed = z.object({ phone: phoneSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid phone number" });
    return;
  }
  const phone = parsed.data.phone;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  console.info(`\n======================================================`);
  console.info(`[MiniLedger OTP] Mobile: ${phone} | Code: ${code} (Valid for 5m)`);
  console.info(`======================================================\n`);
  res.json({
    message: "OTP generated. Check the backend terminal in this demo.",
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
  });
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const parsed = z.object({
    phone: phoneSchema,
    otp: z.string().regex(/^\d{6}$/, "OTP must be six digits"),
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const { phone, otp } = parsed.data;
  const record = otpStore.get(phone);
  if (!record || Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    res.status(400).json({ error: "OTP missing or expired. Request a new OTP." });
    return;
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(phone);
    res.status(429).json({ error: "Too many attempts. Request a new OTP." });
    return;
  }
  record.attempts += 1;
  if (record.code !== otp) {
    res.status(400).json({ error: "Incorrect OTP" });
    return;
  }

  otpStore.delete(phone);
  const user = await prisma.user.upsert({ where: { phone }, update: {}, create: { phone } });
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
