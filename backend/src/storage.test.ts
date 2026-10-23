import { describe, it, expect, afterAll } from "vitest";
import { validateImageMagicBytes, receiptStorage, MAX_RECEIPT_BYTES } from "./storage.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("Storage Service & Image Validation (Pure Unit Tests)", () => {
  const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const validWebp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
    Buffer.from("VP8 "),
  ]);

  it("detects valid JPEG magic bytes", () => {
    expect(validateImageMagicBytes(validJpeg)).toBe("image/jpeg");
  });

  it("detects valid PNG magic bytes", () => {
    expect(validateImageMagicBytes(validPng)).toBe("image/png");
  });

  it("detects valid WebP magic bytes", () => {
    expect(validateImageMagicBytes(validWebp)).toBe("image/webp");
  });

  it("rejects non-image payloads (e.g. plain text, HTML, executables)", () => {
    const textFile = Buffer.from("<html><body>Malicious payload</body></html>");
    expect(() => validateImageMagicBytes(textFile)).toThrow("Invalid file content");
  });

  it("rejects files smaller than 12 bytes", () => {
    const tiny = Buffer.from([0xff, 0xd8, 0xff]);
    expect(() => validateImageMagicBytes(tiny)).toThrow("too small");
  });

  it("saves, retrieves, and deletes a receipt file in local storage", async () => {
    const userId = "test-user-storage";
    const loanId = "test-loan-storage";

    const savedPath = await receiptStorage.save(userId, loanId, validJpeg, "image/jpeg");
    expect(savedPath).toMatch(new RegExp(`^receipts/${userId}/${loanId}_\\d+\\.jpg$`));

    const result = await receiptStorage.get(savedPath);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.buffer).toEqual(validJpeg);

    await receiptStorage.delete(savedPath);
    await expect(receiptStorage.get(savedPath)).rejects.toThrow("not found");
  });

  it("enforces MAX_RECEIPT_BYTES limit", async () => {
    const oversizedBuffer = Buffer.alloc(MAX_RECEIPT_BYTES + 100);
    // write jpeg header to pass magic byte if checked
    oversizedBuffer[0] = 0xff;
    oversizedBuffer[1] = 0xd8;
    oversizedBuffer[2] = 0xff;

    await expect(
      receiptStorage.save("user-1", "loan-1", oversizedBuffer, "image/jpeg")
    ).rejects.toThrow("5MB");
  });
});
