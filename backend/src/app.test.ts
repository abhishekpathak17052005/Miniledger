import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { app } from "./app.js";
import { calculateLoanSummary, isLoanOverdue } from "./calculations.js";
import { signToken, getJwtSecret } from "./auth.js";
import { _otpTestUtils } from "./otp.js";
import { prisma } from "./prisma.js";

describe("MiniLedger API & System Health", () => {
  it("returns healthy status with system info", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("miniledger-api");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await request(app).get("/api/non-existent-route");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Route not found");
  });
});

describe("Phase 3: Phone Validation & OTP Request", () => {
  beforeEach(() => {
    _otpTestUtils.clear();
    _otpTestUtils.resetClock();
  });

  afterEach(() => {
    _otpTestUtils.resetClock();
  });

  it("accepts valid 10-digit Indian phone numbers on /api/auth/request-otp", async () => {
    const validPhones = ["9876543210", "8123456789", "7001234567", "6999888777"];
    for (const phone of validPhones) {
      const response = await request(app).post("/api/auth/request-otp").send({ phone });
      expect(response.status).toBe(200);
      expect(response.body.message).toContain("OTP generated");
      expect(response.body.expiresInSeconds).toBe(300);
      expect(response.body.otp).toBeUndefined();
      expect(response.body.code).toBeUndefined();
    }
  });

  it("supports /api/auth/send-otp as backwards-compatible alias", async () => {
    const response = await request(app).post("/api/auth/send-otp").send({ phone: "9876543210" });
    expect(response.status).toBe(200);
    expect(response.body.message).toContain("OTP generated");
    expect(response.body.otp).toBeUndefined();
  });

  it("rejects invalid phone numbers with descriptive error messages", async () => {
    const invalidPhones = [
      "123", // too short
      "5123456789", // starts with 5 (not 6-9)
      "98765432101", // 11 digits
      "987654321", // 9 digits
      "abcdefghij", // non-numeric
      "", // empty
    ];

    for (const phone of invalidPhones) {
      const response = await request(app).post("/api/auth/request-otp").send({ phone });
      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();
    }
  });

  it("enforces a 60-second cooldown on repeated OTP requests for the same phone", async () => {
    let mockTime = 1700000000000;
    _otpTestUtils.setClock(() => mockTime);

    const testPhone = "9876543210";

    // 1. Initial request: SUCCEEDS
    const firstRes = await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    expect(firstRes.status).toBe(200);
    const initialRecord = _otpTestUtils.getRecord(testPhone)!;
    expect(initialRecord).toBeDefined();

    // 2. Immediate repeated request within 60s cooldown: REJECTED with 429
    const immediateRes = await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    expect(immediateRes.status).toBe(429);
    expect(immediateRes.body.error).toContain("Please wait");
    expect(immediateRes.body.retryAfterSeconds).toBe(60);

    // 3. User attempts a wrong guess: increments attempts count
    await request(app).post("/api/auth/verify-otp").send({ phone: testPhone, otp: "000000" });
    expect(_otpTestUtils.getRecord(testPhone)!.attempts).toBe(1);

    // 4. Repeated request during cooldown CANNOT reset the attempt counter or overwrite code
    mockTime += 30000; // 30s elapsed
    const cooldownRes = await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    expect(cooldownRes.status).toBe(429);
    expect(_otpTestUtils.getRecord(testPhone)!.attempts).toBe(1);
    expect(_otpTestUtils.getRecord(testPhone)!.code).toBe(initialRecord.code);

    // 5. Advance clock past 60s cooldown: resend SUCCEEDS with a fresh OTP
    mockTime += 31000; // 61s total elapsed
    const renewedRes = await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    expect(renewedRes.status).toBe(200);
    expect(renewedRes.body.message).toContain("OTP generated");
    expect(_otpTestUtils.getRecord(testPhone)!.attempts).toBe(0);
  });

  it("suppresses console OTP output in production environment", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const consoleSpy = vi.spyOn(console, "info");

    await request(app).post("/api/auth/request-otp").send({ phone: "9876543210" });
    const otpLogged = consoleSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("[MiniLedger OTP]"))
    );
    expect(otpLogged).toBe(false);

    consoleSpy.mockRestore();
    process.env.NODE_ENV = prevEnv;
  });
});

describe("Phase 3: OTP Verification, Security & User Provisioning", () => {
  const testPhone = "9876543210";

  beforeEach(() => {
    _otpTestUtils.clear();
    _otpTestUtils.resetClock();
  });

  afterEach(() => {
    _otpTestUtils.resetClock();
    vi.restoreAllMocks();
  });

  it("provisions user and returns JWT on valid OTP submission (in-memory mock)", async () => {
    vi.spyOn(prisma.user as any, "upsert").mockResolvedValueOnce({
      id: "mock-user-123",
      phone: testPhone,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    const record = _otpTestUtils.getRecord(testPhone);
    expect(record).toBeDefined();

    const verifyRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: record!.code });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTypeOf("string");
    expect(verifyRes.body.user).toEqual({ id: "mock-user-123", phone: testPhone });
  });

  it("rejects incorrect OTP codes and tracks remaining attempts", async () => {
    await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    const record = _otpTestUtils.getRecord(testPhone)!;

    const wrongOtp = record.code === "111111" ? "222222" : "111111";
    const response = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: wrongOtp });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Incorrect OTP");
    expect(response.body.error).toContain("4 attempt(s) remaining");
  });

  it("rejects expired OTPs", async () => {
    _otpTestUtils.setRecord(testPhone, {
      code: "123456",
      expiresAt: Date.now() - 1000,
      attempts: 0,
      createdAt: Date.now() - 100000,
    });

    const response = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: "123456" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("expired");
  });

  it("strictly prevents OTP reuse (single-use enforcement)", async () => {
    vi.spyOn(prisma.user as any, "upsert").mockResolvedValue({
      id: "mock-user-123",
      phone: testPhone,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    const code = _otpTestUtils.getRecord(testPhone)!.code;

    const firstRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: code });
    expect(firstRes.status).toBe(200);

    const secondRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: code });
    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toContain("already used");
  });

  it("enforces max attempt limit (rate limiting) with 429 response", async () => {
    await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    const record = _otpTestUtils.getRecord(testPhone)!;
    const wrongOtp = record.code === "999999" ? "888888" : "999999";

    for (let i = 1; i <= 4; i++) {
      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: testPhone, otp: wrongOtp });
      expect(res.status).toBe(400);
    }

    const limitRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: wrongOtp });
    expect(limitRes.status).toBe(429);
    expect(limitRes.body.error).toContain("Too many failed attempts");
  });

  it("rejects non-6-digit OTP formats", async () => {
    const invalidOtps = ["123", "abcdef", "1234567", ""];
    for (const otp of invalidOtps) {
      const response = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: testPhone, otp });
      expect(response.status).toBe(400);
    }
  });

  it("returns 400 when verifying OTP for an unrequested number", async () => {
    const response = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: "9999999999", otp: "123456" });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("expired");
  });
});

describe("JWT Middleware & Route Protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects requests missing the Authorization header", async () => {
    const routes = [
      { method: "get", path: "/api/loans" },
      { method: "post", path: "/api/loans" },
      { method: "get", path: "/api/loans/summary" },
      { method: "patch", path: "/api/loans/some-id/repay" },
    ];

    for (const { method, path } of routes) {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Authentication required");
    }
  });

  it("rejects non-Bearer Authorization headers", async () => {
    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", "Basic dXNlcjpwYXNz");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Authentication required");
  });

  it("rejects malformed or tampered JWT tokens", async () => {
    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", "Bearer this-is-not-a-valid-jwt-token");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid or expired token");
  });

  it("rejects tokens signed with an unsupported algorithm (e.g. HS512)", async () => {
    const unsupportedToken = jwt.sign({ userId: "mock-user-1" }, getJwtSecret(), {
      algorithm: "HS512",
      expiresIn: "7d",
    });

    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${unsupportedToken}`);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid or expired token");
  });

  it("rejects tokens for non-existent users with 401 Invalid session", async () => {
    vi.spyOn(prisma.user as any, "findUnique").mockResolvedValueOnce(null);

    const ghostToken = signToken("cm-non-existent-user-id");
    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${ghostToken}`);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid session");
  });
});

describe("Phase 4: Loan Creation & Input Validation (POST /api/loans)", () => {
  const userId = "user-alice";
  const userToken = signToken(userId);

  beforeEach(() => {
    vi.spyOn(prisma.user as any, "findUnique").mockResolvedValue({ id: userId, phone: "9876543210" } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully creates a loan with friend name, positive amount, and valid due date", async () => {
    const mockLoan = {
      id: "loan-101",
      userId,
      friendName: "Riya Sharma",
      amount: new Prisma.Decimal("1500.00"),
      dueDate: new Date("2026-11-15T00:00:00.000Z"),
      status: "PENDING",
      createdAt: new Date("2026-10-23T12:00:00.000Z"),
      updatedAt: new Date("2026-10-23T12:00:00.000Z"),
      repaidAt: null,
    };

    const createSpy = vi.spyOn(prisma.loan as any, "create").mockResolvedValueOnce(mockLoan as any);

    const response = await request(app)
      .post("/api/loans")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        friendName: "Riya Sharma",
        amount: 1500,
        dueDate: "2026-11-15",
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: "loan-101",
      friendName: "Riya Sharma",
      amount: "1500.00",
      dueDate: "2026-11-15",
      status: "PENDING",
      hasReceipt: false,
      receiptUrl: null,
      customOverdueAmount: null,
      createdAt: "2026-10-23T12:00:00.000Z",
      repaidAt: null,
    });
    expect(createSpy).toHaveBeenCalledWith({
      data: {
        userId,
        friendName: "Riya Sharma",
        amount: "1500.00",
        dueDate: new Date("2026-11-15T00:00:00.000Z"),
        customOverdueAmount: null,
        receiptPath: null,
        receiptContentType: null,
      },
    });
  });

  it("rejects loan creation with missing or blank friend name", async () => {
    const invalidBodies = [
      { amount: 500, dueDate: "2026-11-15" },
      { friendName: "", amount: 500, dueDate: "2026-11-15" },
      { friendName: "   ", amount: 500, dueDate: "2026-11-15" },
    ];

    for (const body of invalidBodies) {
      const response = await request(app)
        .post("/api/loans")
        .set("Authorization", `Bearer ${userToken}`)
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Friend name is required");
    }
  });

  it("rejects friend name exceeding 80 characters", async () => {
    const longName = "A".repeat(81);
    const response = await request(app)
      .post("/api/loans")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ friendName: longName, amount: 500, dueDate: "2026-11-15" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("cannot exceed 80 characters");
  });

  it("rejects non-positive and invalid monetary amounts", async () => {
    const invalidAmounts = [0, -100, "abc", null, NaN, Infinity];

    for (const amount of invalidAmounts) {
      const response = await request(app)
        .post("/api/loans")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ friendName: "Aman", amount, dueDate: "2026-11-15" });
      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();
    }
  });

  it("rejects amounts with more than 2 decimal places", async () => {
    const response = await request(app)
      .post("/api/loans")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ friendName: "Aman", amount: 100.555, dueDate: "2026-11-15" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("2 decimal places");
  });

  it("rejects malformed and impossible calendar dates", async () => {
    const invalidDates = [
      "not-a-date",
      "15-11-2026", // wrong format
      "2026-02-31", // invalid day
      "2026-13-01", // invalid month
      "",
    ];

    for (const dueDate of invalidDates) {
      const response = await request(app)
        .post("/api/loans")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ friendName: "Aman", amount: 500, dueDate });
      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();
    }
  });
});

describe("Phase 4: Loan Listing & Strict Ownership (GET /api/loans)", () => {
  const aliceId = "user-alice";
  const bobId = "user-bob";
  const aliceToken = signToken(aliceId);
  const bobToken = signToken(bobId);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only the authenticated user's loans, sorted by status, dueDate, and createdAt", async () => {
    vi.spyOn(prisma.user as any, "findUnique").mockImplementation(async ({ where }: any) => {
      return { id: where.id, phone: "9876543210" } as any;
    });

    const findManySpy = vi.spyOn(prisma.loan as any, "findMany").mockResolvedValueOnce([
      {
        id: "loan-1",
        userId: aliceId,
        friendName: "Pooja",
        amount: new Prisma.Decimal("1200.00"),
        dueDate: new Date("2026-11-01T00:00:00.000Z"),
        status: "PENDING",
        createdAt: new Date("2026-10-20T00:00:00.000Z"),
        updatedAt: new Date("2026-10-20T00:00:00.000Z"),
        repaidAt: null,
      },
    ] as any);

    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].friendName).toBe("Pooja");
    expect(findManySpy).toHaveBeenCalledWith({
      where: { userId: aliceId },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    });
  });

  it("ensures User B receives an empty list when querying their own loans", async () => {
    vi.spyOn(prisma.user as any, "findUnique").mockResolvedValue({ id: bobId, phone: "8123456789" } as any);
    vi.spyOn(prisma.loan as any, "findMany").mockResolvedValueOnce([]);

    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${bobToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe("Phase 4: Loan Repayment & Cross-User Security (PATCH /api/loans/:id/repay)", () => {
  const aliceId = "user-alice";
  const bobId = "user-bob";
  const aliceToken = signToken(aliceId);
  const bobToken = signToken(bobId);

  beforeEach(() => {
    vi.spyOn(prisma.user as any, "findUnique").mockImplementation(async ({ where }: any) => {
      return { id: where.id, phone: "9876543210" } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully marks a pending loan as repaid", async () => {
    const existingLoan = {
      id: "loan-10",
      userId: aliceId,
      friendName: "Sameer",
      amount: new Prisma.Decimal("800.00"),
      dueDate: new Date("2026-11-20T00:00:00.000Z"),
      status: "PENDING",
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      repaidAt: null,
    };

    const repaidLoan = {
      ...existingLoan,
      status: "REPAID",
      repaidAt: new Date("2026-10-23T15:00:00.000Z"),
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(existingLoan as any);
    const updateSpy = vi.spyOn(prisma.loan as any, "update").mockResolvedValueOnce(repaidLoan as any);

    const response = await request(app)
      .patch("/api/loans/loan-10/repay")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("REPAID");
    expect(response.body.repaidAt).toBe("2026-10-23T15:00:00.000Z");
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "loan-10" },
      data: { status: "REPAID", repaidAt: expect.any(Date) },
    });
  });

  it("rejects invalid loan ID formats with 400", async () => {
    const response = await request(app)
      .patch("/api/loans/%20%20/repay") // whitespace
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid loan ID");
  });

  it("prevents cross-user repayment: User B cannot repay User A's loan (404 Loan not found)", async () => {
    // When Bob attempts to find Alice's loan scoped to Bob's userId, findFirst returns null
    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(null);

    const response = await request(app)
      .patch("/api/loans/loan-belonging-to-alice/repay")
      .set("Authorization", `Bearer ${bobToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Loan not found");
  });

  it("prevents double repayment: repeated repayment returns 409 Conflict", async () => {
    const alreadyRepaidLoan = {
      id: "loan-10",
      userId: aliceId,
      friendName: "Sameer",
      amount: new Prisma.Decimal("800.00"),
      dueDate: new Date("2026-11-20T00:00:00.000Z"),
      status: "REPAID",
      createdAt: new Date("2026-10-22T00:00:00.000Z"),
      updatedAt: new Date("2026-10-23T00:00:00.000Z"),
      repaidAt: new Date("2026-10-23T00:00:00.000Z"),
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(alreadyRepaidLoan as any);

    const response = await request(app)
      .patch("/api/loans/loan-10/repay")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Loan is already marked as repaid");
  });
});

describe("Phase 4: Financial Summary & Overdue Semantics (GET /api/loans/summary)", () => {
  const userId = "user-alice";
  const userToken = signToken(userId);

  beforeEach(() => {
    vi.spyOn(prisma.user as any, "findUnique").mockResolvedValue({ id: userId, phone: "9876543210" } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accurately calculates total lent, repaid, overdue, and outstanding amounts using Decimal precision", async () => {
    vi.spyOn(prisma.loan as any, "aggregate").mockImplementation(async ({ where }: any) => {
      if (where.status === "REPAID") {
        return { _sum: { amount: new Prisma.Decimal("1500.50") } } as any;
      }
      // All loans
      return { _sum: { amount: new Prisma.Decimal("4500.75") } } as any;
    });

    vi.spyOn(prisma.loan as any, "findMany").mockResolvedValueOnce([
      { amount: new Prisma.Decimal("800.25"), customOverdueAmount: null },
    ]);

    const response = await request(app)
      .get("/api/loans/summary")
      .set("Authorization", `Bearer ${userToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      totalLent: 4500.75,
      totalRepaid: 1500.5,
      overdueAmount: 800.25,
      outstandingAmount: 3000.25, // 4500.75 - 1500.50 = 3000.25 exact
    });
  });

  it("handles user with zero loans returning all 0s without errors", async () => {
    vi.spyOn(prisma.loan as any, "aggregate").mockResolvedValue({
      _sum: { amount: null },
    } as any);
    vi.spyOn(prisma.loan as any, "findMany").mockResolvedValueOnce([]);

    const response = await request(app)
      .get("/api/loans/summary")
      .set("Authorization", `Bearer ${userToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      totalLent: 0,
      totalRepaid: 0,
      overdueAmount: 0,
      outstandingAmount: 0,
    });
  });

  it("reflects customOverdueAmount in summary when set on an overdue loan", async () => {
    vi.spyOn(prisma.loan as any, "aggregate").mockImplementation(async ({ where }: any) => {
      if (where.status === "REPAID") {
        return { _sum: { amount: new Prisma.Decimal("0") } } as any;
      }
      return { _sum: { amount: new Prisma.Decimal("1000.00") } } as any;
    });

    vi.spyOn(prisma.loan as any, "findMany").mockResolvedValueOnce([
      // Loan amount is 1000.00, but custom overdue amount is set to 1250.00 (e.g. penalty or negotiated)
      { amount: new Prisma.Decimal("1000.00"), customOverdueAmount: new Prisma.Decimal("1250.00") },
    ]);

    const response = await request(app)
      .get("/api/loans/summary")
      .set("Authorization", `Bearer ${userToken}`);

    expect(response.status).toBe(200);
    expect(response.body.overdueAmount).toBe(1250);
  });

  it("ensures loans due today are NOT classified as overdue", () => {
    const referenceDate = new Date("2026-10-23T00:00:00.000Z");

    const loans = [
      { amount: 1000, status: "PENDING" as const, dueDate: "2026-10-23" }, // due TODAY
      { amount: 500, status: "PENDING" as const, dueDate: "2026-10-22" },  // due YESTERDAY -> overdue
    ];

    const summary = calculateLoanSummary(loans, referenceDate);
    expect(summary.totalLent).toBe(1500);
    expect(summary.overdueAmount).toBe(500); // Only yesterday's loan is overdue
    expect(summary.outstandingAmount).toBe(1500);
  });

  it("ensures repaid loans are NEVER overdue even with a past due date", () => {
    const referenceDate = new Date("2026-10-23T00:00:00.000Z");

    const loans = [
      { amount: 2000, status: "REPAID" as const, dueDate: "2026-10-01" }, // past due but REPAID
      { amount: 500, status: "PENDING" as const, dueDate: "2026-10-20" },  // past due and PENDING
    ];

    const summary = calculateLoanSummary(loans, referenceDate);
    expect(summary.overdueAmount).toBe(500);
    expect(summary.totalRepaid).toBe(2000);
    expect(summary.outstandingAmount).toBe(500);
  });

  it("calculates customOverdueAmount in pure calculation function", () => {
    const referenceDate = new Date("2026-10-23T00:00:00.000Z");

    const loans = [
      { amount: 1000, status: "PENDING" as const, dueDate: "2026-10-20", customOverdueAmount: 1150 }, // overdue with custom amount
      { amount: 500, status: "PENDING" as const, dueDate: "2026-10-20" }, // overdue with default amount
    ];

    const summary = calculateLoanSummary(loans, referenceDate);
    expect(summary.totalLent).toBe(1500);
    expect(summary.overdueAmount).toBe(1650); // 1150 + 500
  });
});

describe("Phase 4: Database Error Handling", () => {
  const userId = "user-alice";
  const userToken = signToken(userId);

  beforeEach(() => {
    vi.spyOn(prisma.user as any, "findUnique").mockResolvedValue({ id: userId, phone: "9876543210" } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns HTTP 500 Internal server error when database throws an unexpected error on GET /api/loans", async () => {
    vi.spyOn(prisma.loan as any, "findMany").mockRejectedValueOnce(new Error("Database connection lost"));

    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${userToken}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Internal server error");
  });

  it("returns HTTP 500 Internal server error when database throws on POST /api/loans", async () => {
    vi.spyOn(prisma.loan as any, "create").mockRejectedValueOnce(new Error("Unique constraint violation"));

    const response = await request(app)
      .post("/api/loans")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ friendName: "Kunal", amount: 100, dueDate: "2026-11-01" });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Internal server error");
  });
});

describe("Financial Business Logic & Calculations (Pure Unit Tests)", () => {
  const refDate = new Date("2026-10-22T00:00:00.000Z");

  it("handles zero loans gracefully", () => {
    const summary = calculateLoanSummary([], refDate);
    expect(summary).toEqual({
      totalLent: 0,
      totalRepaid: 0,
      overdueAmount: 0,
      outstandingAmount: 0,
    });
  });

  it("correctly calculates total lent, repaid, and outstanding amounts", () => {
    const loans = [
      { amount: 1500, status: "PENDING" as const, dueDate: "2026-10-25" },
      { amount: 500.5, status: "REPAID" as const, dueDate: "2026-10-15" },
      { amount: 1000, status: "PENDING" as const, dueDate: "2026-10-30" },
    ];

    const summary = calculateLoanSummary(loans, refDate);
    expect(summary.totalLent).toBe(3000.5);
    expect(summary.totalRepaid).toBe(500.5);
    expect(summary.outstandingAmount).toBe(2500);
    expect(summary.overdueAmount).toBe(0);
  });

  it("evaluates single loan overdue helper accurately", () => {
    expect(isLoanOverdue({ status: "PENDING", dueDate: "2026-10-20" }, refDate)).toBe(true);
    expect(isLoanOverdue({ status: "PENDING", dueDate: "2026-10-23" }, refDate)).toBe(false);
    expect(isLoanOverdue({ status: "REPAID", dueDate: "2026-10-10" }, refDate)).toBe(false);
  });
});

describe("Phase 7: Receipt Photo Upload, Security & Isolation", () => {
  const aliceId = "user-alice";
  const bobId = "user-bob";
  const aliceToken = signToken(aliceId);
  const bobToken = signToken(bobId);

  const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

  beforeEach(() => {
    vi.spyOn(prisma.user as any, "findUnique").mockImplementation(async ({ where }: any) => {
      return { id: where.id, phone: "9876543210" } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects receipt upload with unsupported MIME types", async () => {
    const res = await request(app)
      .post("/api/loans/loan-1/receipt")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        imageBase64: Buffer.from("dummy").toString("base64"),
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Only JPEG, PNG, and WebP images are allowed");
  });

  it("rejects receipt upload with mismatched or corrupted magic bytes", async () => {
    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce({
      id: "loan-1",
      userId: aliceId,
    } as any);

    const fakeJpeg = Buffer.from("This is plain text pretending to be jpeg");
    const res = await request(app)
      .post("/api/loans/loan-1/receipt")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        imageBase64: fakeJpeg.toString("base64"),
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid file content");
  });

  it("strictly prevents cross-user receipt attachment (User B cannot attach to User A's loan -> 404)", async () => {
    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/loans/alice-loan-id/receipt")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({
        imageBase64: sampleJpeg.toString("base64"),
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Loan not found");
  });

  it("strictly prevents cross-user receipt access (User B cannot view User A's receipt -> 404)", async () => {
    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/api/loans/alice-loan-id/receipt")
      .set("Authorization", `Bearer ${bobToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Loan not found");
  });

  it("rejects unauthenticated receipt upload and access with 401", async () => {
    const postRes = await request(app)
      .post("/api/loans/some-id/receipt")
      .send({ imageBase64: sampleJpeg.toString("base64"), contentType: "image/jpeg" });
    expect(postRes.status).toBe(401);

    const getRes = await request(app).get("/api/loans/some-id/receipt");
    expect(getRes.status).toBe(401);
  });

  it("successfully attaches a receipt photo to an existing loan", async () => {
    const existingLoan = {
      id: "loan-99",
      userId: aliceId,
      friendName: "Rahul",
      amount: new Prisma.Decimal("500.00"),
      dueDate: new Date("2026-11-20T00:00:00.000Z"),
      status: "PENDING",
      createdAt: new Date("2026-10-23T10:00:00.000Z"),
      repaidAt: null,
      receiptPath: null,
      receiptContentType: null,
    };

    const updatedLoan = {
      ...existingLoan,
      receiptPath: `receipts/${aliceId}/loan-99.jpg`,
      receiptContentType: "image/jpeg",
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(existingLoan as any);
    const updateSpy = vi.spyOn(prisma.loan as any, "update").mockResolvedValueOnce(updatedLoan as any);

    const res = await request(app)
      .post("/api/loans/loan-99/receipt")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        imageBase64: sampleJpeg.toString("base64"),
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(200);
    expect(res.body.hasReceipt).toBe(true);
    expect(res.body.receiptUrl).toBe("/api/loans/loan-99/receipt");
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "loan-99" },
      data: {
        receiptPath: expect.stringContaining("receipts"),
        receiptContentType: "image/jpeg",
      },
    });
  });

  it("successfully serves receipt image to the owner", async () => {
    // save real file to local disk for test
    const { receiptStorage } = await import("./storage.js");
    await receiptStorage.save(aliceId, "loan-serve-test", sampleJpeg, "image/jpeg");

    const loanWithReceipt = {
      id: "loan-serve-test",
      userId: aliceId,
      friendName: "Rahul",
      receiptPath: `receipts/${aliceId}/loan-serve-test.jpg`,
      receiptContentType: "image/jpeg",
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(loanWithReceipt as any);

    const res = await request(app)
      .get("/api/loans/loan-serve-test/receipt")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.body).toEqual(sampleJpeg);
  });

  it("supports ?format=json to return data URL", async () => {
    const { receiptStorage } = await import("./storage.js");
    await receiptStorage.save(aliceId, "loan-json-test", sampleJpeg, "image/jpeg");

    const loanWithReceipt = {
      id: "loan-json-test",
      userId: aliceId,
      friendName: "Rahul",
      receiptPath: `receipts/${aliceId}/loan-json-test.jpg`,
      receiptContentType: "image/jpeg",
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(loanWithReceipt as any);

    const res = await request(app)
      .get("/api/loans/loan-json-test/receipt?format=json")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("data:image/jpeg;base64,");
    expect(res.body.contentType).toBe("image/jpeg");
  });

  it("successfully deletes receipt from loan", async () => {
    const loanWithReceipt = {
      id: "loan-99",
      userId: aliceId,
      friendName: "Rahul",
      amount: new Prisma.Decimal("500.00"),
      dueDate: new Date("2026-11-20T00:00:00.000Z"),
      status: "PENDING",
      createdAt: new Date("2026-10-23T10:00:00.000Z"),
      repaidAt: null,
      receiptPath: `receipts/${aliceId}/loan-99.jpg`,
      receiptContentType: "image/jpeg",
    };

    const loanWithoutReceipt = {
      ...loanWithReceipt,
      receiptPath: null,
      receiptContentType: null,
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(loanWithReceipt as any);
    const updateSpy = vi.spyOn(prisma.loan as any, "update").mockResolvedValueOnce(loanWithoutReceipt as any);

    const res = await request(app)
      .delete("/api/loans/loan-99/receipt")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hasReceipt).toBe(false);
    expect(res.body.receiptUrl).toBeNull();
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "loan-99" },
      data: { receiptPath: null, receiptContentType: null },
    });
  });
});

describe("Custom Overdue Amount (PATCH /api/loans/:id/overdue)", () => {
  const aliceId = "user-alice";
  const bobId = "user-bob";
  const aliceToken = signToken(aliceId);
  const bobToken = signToken(bobId);

  beforeEach(() => {
    vi.spyOn(prisma.user as any, "findUnique").mockImplementation(async ({ where }: any) => {
      return { id: where.id, phone: "9876543210" } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates custom overdue amount on an existing loan", async () => {
    const existingLoan = {
      id: "loan-custom-1",
      userId: aliceId,
      friendName: "Vikram",
      amount: new Prisma.Decimal("1000.00"),
      dueDate: new Date("2026-10-20T00:00:00.000Z"),
      status: "PENDING",
      customOverdueAmount: null,
      createdAt: new Date(),
      repaidAt: null,
    };

    const updatedLoan = {
      ...existingLoan,
      customOverdueAmount: new Prisma.Decimal("1200.00"),
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(existingLoan as any);
    const updateSpy = vi.spyOn(prisma.loan as any, "update").mockResolvedValueOnce(updatedLoan as any);

    const res = await request(app)
      .patch("/api/loans/loan-custom-1/overdue")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ customOverdueAmount: 1200 });

    expect(res.status).toBe(200);
    expect(res.body.customOverdueAmount).toBe("1200.00");
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "loan-custom-1" },
      data: { customOverdueAmount: "1200.00" },
    });
  });

  it("allows clearing custom overdue amount by passing null", async () => {
    const existingLoan = {
      id: "loan-custom-1",
      userId: aliceId,
      friendName: "Vikram",
      amount: new Prisma.Decimal("1000.00"),
      dueDate: new Date("2026-10-20T00:00:00.000Z"),
      status: "PENDING",
      customOverdueAmount: new Prisma.Decimal("1200.00"),
      createdAt: new Date(),
      repaidAt: null,
    };

    const clearedLoan = {
      ...existingLoan,
      customOverdueAmount: null,
    };

    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(existingLoan as any);
    const updateSpy = vi.spyOn(prisma.loan as any, "update").mockResolvedValueOnce(clearedLoan as any);

    const res = await request(app)
      .patch("/api/loans/loan-custom-1/overdue")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ customOverdueAmount: null });

    expect(res.status).toBe(200);
    expect(res.body.customOverdueAmount).toBeNull();
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "loan-custom-1" },
      data: { customOverdueAmount: null },
    });
  });

  it("prevents Bob from modifying Alice's overdue amount (404 Loan not found)", async () => {
    vi.spyOn(prisma.loan as any, "findFirst").mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/api/loans/alice-loan-id/overdue")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ customOverdueAmount: 500 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Loan not found");
  });

  it("rejects negative overdue amounts or more than 2 decimal places with 400", async () => {
    const resNegative = await request(app)
      .patch("/api/loans/loan-custom-1/overdue")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ customOverdueAmount: -50 });
    expect(resNegative.status).toBe(400);

    const resDecimals = await request(app)
      .patch("/api/loans/loan-custom-1/overdue")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ customOverdueAmount: 50.123 });
    expect(resDecimals.status).toBe(400);
  });
});

