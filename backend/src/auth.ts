import "dotenv/config";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./prisma.js";

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 characters in environment variables");
  }
  return secret;
}

export type TokenPayload = { userId: string };
export type AuthRequest = Request & { userId?: string };

/**
 * Generates a signed, tamper-proof JWT token for an authenticated user ID.
 */
export function signToken(userId: string): string {
  return jwt.sign({ userId } satisfies TokenPayload, getJwtSecret(), {
    algorithm: "HS256",
    expiresIn: "7d",
  });
}

/**
 * Authentication middleware that validates Bearer JWT tokens and attaches
 * the authenticated user ID (req.userId) to the request object.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.slice(7).trim();
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      algorithms: ["HS256"],
    }) as TokenPayload;
    if (!payload?.userId) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true },
    });

    if (!user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    req.userId = user.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
