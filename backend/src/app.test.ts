import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./app.js";

describe("MiniLedger API basics", () => {
  it("returns healthy status", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("rejects an invalid phone number", async () => {
    const response = await request(app).post("/api/auth/send-otp").send({ phone: "123" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBeTruthy();
  });

  it("protects the loan list", async () => {
    const response = await request(app).get("/api/loans");
    expect(response.status).toBe(401);
  });
});
