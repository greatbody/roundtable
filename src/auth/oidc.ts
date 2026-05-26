// Minimal zero-dependency OIDC client.
// Implements: discovery, PKCE, authorization redirect URL, code exchange, userinfo.
// We do NOT validate the id_token signature locally — we trust userinfo over HTTPS
// to the same issuer for sub/email/name. This is acceptable because the code exchange
// itself is over TLS to the issuer's token endpoint with client secret.

import { randomBytes, createHash } from "node:crypto";

export interface OidcConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
}

export interface OidcClientOptions {
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes?: string[]; // default: openid profile email
}

export interface OidcUser {
  sub: string;
  email: string | null;
  name: string | null;
  preferred_username: string | null;
}

let cachedConfig: OidcConfig | null = null;

export async function discover(issuer: string): Promise<OidcConfig> {
  if (cachedConfig && cachedConfig.issuer === issuer) return cachedConfig;
  const base = issuer.replace(/\/$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[oidc] discovery failed at ${url}: HTTP ${res.status}`);
  }
  const data: any = await res.json();
  cachedConfig = {
    issuer: data.issuer ?? issuer,
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    userinfo_endpoint: data.userinfo_endpoint,
    end_session_endpoint: data.end_session_endpoint,
  };
  if (!cachedConfig.authorization_endpoint || !cachedConfig.token_endpoint || !cachedConfig.userinfo_endpoint) {
    throw new Error(`[oidc] discovery doc missing required endpoints`);
  }
  return cachedConfig;
}

export function generatePkce(): { verifier: string; challenge: string } {
  // verifier: 43-128 unreserved chars; we use base64url of 32 random bytes (43 chars).
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomToken(bytes = 16): string {
  return base64url(randomBytes(bytes));
}

export interface AuthRequestParams {
  state: string;
  nonce: string;
  code_verifier: string;
}

export async function buildAuthorizeUrl(
  opts: OidcClientOptions,
  params: AuthRequestParams,
): Promise<string> {
  const config = await discover(opts.issuer);
  const challenge = base64url(createHash("sha256").update(params.code_verifier).digest());
  const u = new URL(config.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.client_id);
  u.searchParams.set("redirect_uri", opts.redirect_uri);
  u.searchParams.set("scope", (opts.scopes ?? ["openid", "profile", "email"]).join(" "));
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(
  opts: OidcClientOptions,
  code: string,
  code_verifier: string,
): Promise<{ access_token: string; id_token?: string; refresh_token?: string; expires_in?: number }> {
  const config = await discover(opts.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: opts.redirect_uri,
    client_id: opts.client_id,
    client_secret: opts.client_secret,
    code_verifier,
  });
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[oidc] token exchange failed: HTTP ${res.status} ${text}`);
  }
  return res.json() as any;
}

export async function fetchUserinfo(
  opts: OidcClientOptions,
  access_token: string,
): Promise<OidcUser> {
  const config = await discover(opts.issuer);
  const res = await fetch(config.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[oidc] userinfo failed: HTTP ${res.status} ${text}`);
  }
  const data: any = await res.json();
  if (!data.sub) throw new Error("[oidc] userinfo response missing sub");
  return {
    sub: String(data.sub),
    email: typeof data.email === "string" ? data.email : null,
    name:
      (typeof data.name === "string" && data.name) ||
      (typeof data.preferred_username === "string" && data.preferred_username) ||
      null,
    preferred_username:
      typeof data.preferred_username === "string" ? data.preferred_username : null,
  };
}

// ===== Helpers =====
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
