// Cookie-based session management.
// Cookie value: `<sessionId>.<hmacSig>`, HMAC-SHA256(sessionId, SESSION_SECRET) base64url.
// Server stores `(sessionId, user_id, expires_at)` in the sessions table.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Storage } from "../core/storage.ts";
import type { User } from "../core/types.ts";

export const SESSION_COOKIE = "rt_sid";
export const OIDC_STATE_COOKIE = "rt_oidc";

// Default session lifetime: 30 days, rolling.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// OIDC handshake state cookie: 10 minutes.
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

export interface AuthEnv {
  sessionSecret: string;
  cookieSecure: boolean; // set true behind HTTPS
}

// ===== Cookie parsing / serialization =====

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export interface CookieOpts {
  maxAgeMs?: number;
  path?: string;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAgeMs != null) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(name: string, opts: CookieOpts = {}): string {
  return serializeCookie(name, "", { ...opts, maxAgeMs: 0 });
}

// ===== Signing =====

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signedValue(value: string, secret: string): string {
  return `${value}.${sign(value, secret)}`;
}

export function verifySigned(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = sign(value, secret);
  if (sig.length !== expected.length) return null;
  try {
    if (timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return value;
  } catch {
    return null;
  }
  return null;
}

// ===== Session lookup =====

export interface SessionResult {
  user: User;
  sessionId: string;
}

export function getSessionFromRequest(
  req: Request,
  storage: Storage,
  env: AuthEnv,
): SessionResult | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const sessionId = verifySigned(raw, env.sessionSecret);
  if (!sessionId) return null;
  const sess = storage.getSession(sessionId);
  if (!sess) return null;
  if (sess.expires_at < Date.now()) {
    storage.deleteSession(sessionId);
    return null;
  }
  const user = storage.getUser(sess.user_id);
  if (!user) return null;
  // Rolling expiry: extend if more than 1 day has passed since last touch
  // (cheap heuristic — we only know expires_at, not last_touch; refresh if < 50% TTL remaining)
  const remaining = sess.expires_at - Date.now();
  if (remaining < SESSION_TTL_MS / 2) {
    storage.touchSession(sessionId, SESSION_TTL_MS);
  }
  return { user, sessionId };
}

// ===== Session creation =====

export function createNewSession(storage: Storage, userId: string): string {
  const id = randomBytes(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  storage.createSession(id, userId, SESSION_TTL_MS);
  return id;
}
