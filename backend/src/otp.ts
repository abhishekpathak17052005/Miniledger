import crypto from "crypto";
import { z } from "zod";

export interface OtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes validity
export const OTP_COOLDOWN_MS = 60 * 1000; // 60 seconds resend cooldown
export const MAX_ATTEMPTS = 5; // Maximum verification attempts per OTP

// Indian phone number schema: 10 digits starting with 6, 7, 8, or 9
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number");

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "OTP must be six digits");

// In-memory OTP storage mapping phone -> OtpRecord
const otpStore = new Map<string, OtpRecord>();

/**
 * Clock provider allowing deterministic time control during automated testing.
 */
let clock = () => Date.now();

/**
 * Generates a cryptographically secure 6-digit OTP string.
 */
export function generateSecureOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export type RequestOtpResult =
  | { success: true; expiresInSeconds: number; codeForDev?: string }
  | { success: false; status: 429; error: string; retryAfterSeconds: number };

/**
 * Requests an OTP for a validated phone number.
 * Enforces a 60-second cooldown to prevent abuse and brute-force attempt resets.
 */
export function requestOtp(phone: string): RequestOtpResult {
  const normalizedPhone = phone.trim();
  const now = clock();
  const existing = otpStore.get(normalizedPhone);

  // Check 60-second cooldown
  if (existing && now < existing.createdAt + OTP_COOLDOWN_MS) {
    const remainingMs = existing.createdAt + OTP_COOLDOWN_MS - now;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return {
      success: false,
      status: 429,
      error: `Please wait ${retryAfterSeconds} second(s) before requesting another OTP.`,
      retryAfterSeconds,
    };
  }

  const code = generateSecureOtp();
  otpStore.set(normalizedPhone, {
    code,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    createdAt: now,
  });

  // Never log secrets or OTPs in production mode
  if (process.env.NODE_ENV !== "production") {
    console.info(`\n======================================================`);
    console.info(`[MiniLedger OTP] Mobile: ${normalizedPhone} | Code: ${code} (Valid for 5m)`);
    console.info(`======================================================\n`);
  }

  return {
    success: true,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    ...(process.env.NODE_ENV === "test" ? { codeForDev: code } : {}),
  };
}

export type VerifyOtpResult =
  | { success: true }
  | { success: false; status: 400 | 429; error: string };

/**
 * Verifies an OTP for a given phone number.
 * Enforces expiration, attempt limits, and single-use (deletes on success or max attempts).
 */
export function verifyOtp(phone: string, inputOtp: string): VerifyOtpResult {
  const normalizedPhone = phone.trim();
  const now = clock();
  const record = otpStore.get(normalizedPhone);

  if (!record || now > record.expiresAt) {
    if (record) {
      otpStore.delete(normalizedPhone);
    }
    return {
      success: false,
      status: 400,
      error: "OTP missing, expired, or already used. Please request a new OTP.",
    };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(normalizedPhone);
    return {
      success: false,
      status: 429,
      error: "Too many failed attempts. Please request a new OTP.",
    };
  }

  record.attempts += 1;

  // Constant-time string comparison to prevent timing attacks
  const isMatch =
    record.code.length === inputOtp.length &&
    crypto.timingSafeEqual(Buffer.from(record.code), Buffer.from(inputOtp));

  if (!isMatch) {
    if (record.attempts >= MAX_ATTEMPTS) {
      otpStore.delete(normalizedPhone);
      return {
        success: false,
        status: 429,
        error: "Too many failed attempts. Please request a new OTP.",
      };
    }
    return {
      success: false,
      status: 400,
      error: `Incorrect OTP. ${MAX_ATTEMPTS - record.attempts} attempt(s) remaining.`,
    };
  }

  // Verification succeeded: delete record immediately so it cannot be reused!
  otpStore.delete(normalizedPhone);
  return { success: true };
}

/**
 * Deterministic test helpers (only used in test suites).
 */
export const _otpTestUtils = {
  getRecord: (phone: string) => otpStore.get(phone.trim()),
  setRecord: (phone: string, record: OtpRecord) => otpStore.set(phone.trim(), record),
  clear: () => otpStore.clear(),
  setClock: (fn: () => number) => { clock = fn; },
  resetClock: () => { clock = () => Date.now(); },
};
