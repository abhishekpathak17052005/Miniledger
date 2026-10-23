import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "./app.js";
import { calculateLoanSummary, isLoanOverdue } from "./calculations.js";
import { signToken, getJwtSecret } from "./auth.js";
import { _otpTestUtils, OTP_TTL_MS, OTP_COOLDOWN_MS, MAX_ATTEMPTS } from "./otp.js";
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
      // Security requirement: NEVER return the OTP in the API response!
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
  });

  it("provisions user and returns JWT on valid OTP submission", async () => {
    // 1. Request OTP
    await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    const record = _otpTestUtils.getRecord(testPhone);
    expect(record).toBeDefined();
    expect(record!.code).toMatch(/^\d{6}$/);

    // 2. Submit valid OTP
    const verifyRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: record!.code });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.token).toBeTypeOf("string");
    expect(verifyRes.body.token.split(".")).toHaveLength(3);
    expect(verifyRes.body.user).toBeDefined();
    expect(verifyRes.body.user.phone).toBe(testPhone);
    expect(verifyRes.body.user.id).toBeTypeOf("string");

    // 3. Confirm user exists in the database
    const dbUser = await prisma.user.findUnique({ where: { phone: testPhone } });
    expect(dbUser).not.toBeNull();
    expect(dbUser!.id).toBe(verifyRes.body.user.id);
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
    // Inject expired OTP record
    _otpTestUtils.setRecord(testPhone, {
      code: "123456",
      expiresAt: Date.now() - 1000, // 1 second in the past
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
    await request(app).post("/api/auth/request-otp").send({ phone: testPhone });
    const code = _otpTestUtils.getRecord(testPhone)!.code;

    // First verification: SUCCESS
    const firstRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: code });
    expect(firstRes.status).toBe(200);

    // Second verification with identical OTP: REJECTED
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

    // 4 failed attempts: return 400
    for (let i = 1; i <= 4; i++) {
      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: testPhone, otp: wrongOtp });
      expect(res.status).toBe(400);
    }

    // 5th failed attempt: reaches MAX_ATTEMPTS, returns 429
    const limitRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: wrongOtp });
    expect(limitRes.status).toBe(429);
    expect(limitRes.body.error).toContain("Too many failed attempts");

    // Code is discarded; any further attempt returns 400 missing
    const subsequentRes = await request(app)
      .post("/api/auth/verify-otp")
      .send({ phone: testPhone, otp: record.code });
    expect(subsequentRes.status).toBe(400);
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
    const testUser = await prisma.user.upsert({
      where: { phone: "9123456780" },
      update: {},
      create: { phone: "9123456780" },
    });

    // Token signed with HS512 instead of HS256
    const unsupportedToken = jwt.sign({ userId: testUser.id }, getJwtSecret(), {
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
    const ghostToken = signToken("cm-non-existent-user-id");
    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${ghostToken}`);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid session");
  });

  it("allows access to user-scoped loan endpoints with valid Bearer JWT", async () => {
    // 1. Ensure a valid test user exists
    const testUser = await prisma.user.upsert({
      where: { phone: "9123456780" },
      update: {},
      create: { phone: "9123456780" },
    });

    const token = signToken(testUser.id);

    // 2. Access protected endpoint
    const response = await request(app)
      .get("/api/loans")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe("Financial Business Logic & Calculations", () => {
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

  it("flags pending loans with due date before reference date as overdue", () => {
    const loans = [
      { amount: 1200, status: "PENDING" as const, dueDate: "2026-10-10" },
      { amount: 800, status: "PENDING" as const, dueDate: "2026-10-24" },
    ];

    const summary = calculateLoanSummary(loans, refDate);
    expect(summary.overdueAmount).toBe(1200);
    expect(summary.outstandingAmount).toBe(2000);
  });

  it("ensures repaid loans are NEVER counted as overdue even if dueDate < today", () => {
    const loans = [
      { amount: 2000, status: "REPAID" as const, dueDate: "2026-10-01" },
      { amount: 1000, status: "PENDING" as const, dueDate: "2026-10-05" },
    ];

    const summary = calculateLoanSummary(loans, refDate);
    expect(summary.overdueAmount).toBe(1000);
    expect(summary.totalRepaid).toBe(2000);
    expect(summary.outstandingAmount).toBe(1000);
  });

  it("evaluates single loan overdue helper accurately", () => {
    expect(isLoanOverdue({ status: "PENDING", dueDate: "2026-10-20" }, refDate)).toBe(true);
    expect(isLoanOverdue({ status: "PENDING", dueDate: "2026-10-23" }, refDate)).toBe(false);
    expect(isLoanOverdue({ status: "REPAID", dueDate: "2026-10-10" }, refDate)).toBe(false);
  });
});
