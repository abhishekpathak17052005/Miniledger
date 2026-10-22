import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./app.js";
import { calculateLoanSummary, isLoanOverdue } from "./calculations.js";
import { signToken } from "./auth.js";

describe("MiniLedger API & System Health", () => {
  it("returns healthy status with system info", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await request(app).get("/api/non-existent-route");
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Route not found");
  });
});

describe("Authentication & OTP Validation", () => {
  it("accepts valid 10-digit Indian phone numbers starting with 6-9", async () => {
    const validPhones = ["9876543210", "8123456789", "7001234567", "6999888777"];
    for (const phone of validPhones) {
      const response = await request(app).post("/api/auth/send-otp").send({ phone });
      expect(response.status).toBe(200);
      expect(response.body.message).toContain("OTP generated");
    }
  });

  it("rejects invalid phone numbers with descriptive error messages", async () => {
    const invalidPhones = [
      "123",
      "5123456789", // starts with 5
      "98765432101", // 11 digits
      "987654321", // 9 digits
      "abcdefghij",
      "",
    ];

    for (const phone of invalidPhones) {
      const response = await request(app).post("/api/auth/send-otp").send({ phone });
      expect(response.status).toBe(400);
      expect(response.body.error).toBeTruthy();
    }
  });

  it("rejects OTP verification when OTP is missing or wrong format", async () => {
    const res1 = await request(app).post("/api/auth/verify-otp").send({ phone: "9876543210" });
    expect(res1.status).toBe(400);

    const res2 = await request(app).post("/api/auth/verify-otp").send({ phone: "9876543210", otp: "123" });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toContain("six digits");

    const res3 = await request(app).post("/api/auth/verify-otp").send({ phone: "9876543210", otp: "abcdef" });
    expect(res3.status).toBe(400);
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

  it("signs and validates JWT token structure", () => {
    const token = signToken("test-user-id");
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
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
    expect(summary.overdueAmount).toBe(0); // none are overdue pending
  });

  it("flags pending loans with due date before reference date as overdue", () => {
    const loans = [
      { amount: 1200, status: "PENDING" as const, dueDate: "2026-10-10" }, // overdue
      { amount: 800, status: "PENDING" as const, dueDate: "2026-10-24" },  // future
    ];

    const summary = calculateLoanSummary(loans, refDate);
    expect(summary.overdueAmount).toBe(1200);
    expect(summary.outstandingAmount).toBe(2000);
  });

  it("ensures repaid loans are NEVER counted as overdue even if dueDate < today", () => {
    const loans = [
      { amount: 2000, status: "REPAID" as const, dueDate: "2026-10-01" }, // past due but repaid!
      { amount: 1000, status: "PENDING" as const, dueDate: "2026-10-05" }, // past due and pending -> overdue
    ];

    const summary = calculateLoanSummary(loans, refDate);
    expect(summary.overdueAmount).toBe(1000); // Only the pending one
    expect(summary.totalRepaid).toBe(2000);
    expect(summary.outstandingAmount).toBe(1000);
  });

  it("evaluates single loan overdue helper accurately", () => {
    expect(isLoanOverdue({ status: "PENDING", dueDate: "2026-10-20" }, refDate)).toBe(true);
    expect(isLoanOverdue({ status: "PENDING", dueDate: "2026-10-23" }, refDate)).toBe(false);
    expect(isLoanOverdue({ status: "REPAID", dueDate: "2026-10-10" }, refDate)).toBe(false);
  });
});
