import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads", "receipts");

// Ensure local private uploads directory exists
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Validates that the buffer has the correct magic bytes for allowed image types
 */
export function validateImageMagicBytes(buffer: Buffer): AllowedMimeType {
  if (buffer.length < 12) {
    throw new Error("File is too small to be a valid image");
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: RIFF ... WEBP
  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  if (riff === "RIFF" && webp === "WEBP") {
    return "image/webp";
  }

  throw new Error("Invalid file content. File does not match supported image formats (JPEG, PNG, WebP)");
}

export function getExtensionForMime(mime: AllowedMimeType): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

/**
 * Validates base64 string format
 */
export function isValidBase64(str: string): boolean {
  const clean = str.replace(/^data:[^;]+;base64,/, "").trim();
  if (clean.length === 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(clean);
}

/**
 * Storage service: abstracts Supabase Storage and private local disk storage
 */
export const receiptStorage = {
  /**
   * Saves receipt image.
   * Path is strictly generated server-side and sanitized against path traversal.
   */
  async save(userId: string, loanId: string, buffer: Buffer, mimeType: AllowedMimeType): Promise<string> {
    if (buffer.length > MAX_RECEIPT_BYTES) {
      throw new Error(`Receipt image exceeds maximum size limit of 5MB (got ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);
    }

    const detectedMime = validateImageMagicBytes(buffer);
    const ext = getExtensionForMime(detectedMime);

    // Sanitize user-controlled identifiers to prevent directory traversal
    const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeLoanId = loanId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeUserId || !safeLoanId) {
      throw new Error("Invalid characters in storage identifier");
    }

    const filename = `${safeLoanId}_${Date.now()}.${ext}`;
    const relativePath = path.posix.join("receipts", safeUserId, filename);

    // If Supabase Storage credentials are provided, store in Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const supabase = createClient(supabaseUrl, supabaseKey);
        const { error } = await supabase.storage
          .from("receipts")
          .upload(relativePath, buffer, {
            contentType: detectedMime,
            upsert: true,
          });
        if (error) throw error;
        return relativePath;
      } catch (err: any) {
        if (process.env.NODE_ENV !== "test") {
          console.warn("[Storage] Supabase upload failed, falling back to local storage:", err.message);
        }
      }
    }

    // Local private storage fallback (persisted outside public directory)
    const userDir = path.resolve(UPLOADS_DIR, safeUserId);
    if (!userDir.startsWith(UPLOADS_DIR)) {
      throw new Error("Invalid storage directory path");
    }
    if (!existsSync(userDir)) {
      await fs.mkdir(userDir, { recursive: true });
    }

    const fullPath = path.resolve(userDir, filename);
    if (!fullPath.startsWith(userDir)) {
      throw new Error("Invalid storage file path");
    }

    await fs.writeFile(fullPath, buffer);
    return relativePath;
  },

  /**
   * Retrieves receipt file content or signed URL with path traversal protection
   */
  async get(relativePath: string): Promise<{ buffer?: Buffer; signedUrl?: string; mimeType: AllowedMimeType }> {
    const ext = path.extname(relativePath).replace(".", "").toLowerCase();
    let mimeType: AllowedMimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    if (ext === "webp") mimeType = "image/webp";

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const supabase = createClient(supabaseUrl, supabaseKey);
        const { data, error } = await supabase.storage.from("receipts").createSignedUrl(relativePath, 60);
        if (!error && data?.signedUrl) {
          return { signedUrl: data.signedUrl, mimeType };
        }
      } catch {
        // fall back to local disk
      }
    }

    // Local disk fetch with strict path containment check
    const normalized = relativePath.startsWith("receipts/") ? relativePath.slice("receipts/".length) : relativePath;
    const fullPath = path.resolve(UPLOADS_DIR, normalized);
    if (!fullPath.startsWith(UPLOADS_DIR)) {
      throw new Error("Invalid receipt path traversal");
    }
    if (!existsSync(fullPath)) {
      throw new Error("Receipt file not found on disk");
    }
    const buffer = await fs.readFile(fullPath);
    return { buffer, mimeType };
  },

  /**
   * Deletes a receipt from storage with path traversal protection
   */
  async delete(relativePath: string): Promise<void> {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const supabase = createClient(supabaseUrl, supabaseKey);
        await supabase.storage.from("receipts").remove([relativePath]);
      } catch {
        // ignore
      }
    }

    try {
      const normalized = relativePath.startsWith("receipts/") ? relativePath.slice("receipts/".length) : relativePath;
      const fullPath = path.resolve(UPLOADS_DIR, normalized);
      if (fullPath.startsWith(UPLOADS_DIR) && existsSync(fullPath)) {
        await fs.unlink(fullPath);
      }
    } catch {
      // ignore
    }
  },
};
