// OIDC authorization-code flow routes.
//   GET /auth/login    → generate PKCE + state, set temp cookie, 302 to issuer
//   GET /auth/callback → validate state, exchange code, upsert user, issue session
//   POST /auth/logout  → clear session
//   GET /api/me        → current user info (or 401)

import type { Storage } from "../core/storage.ts";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  generatePkce,
  randomToken,
  type OidcClientOptions,
} from "./oidc.ts";
import {
  AuthEnv,
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearedCookie,
  createNewSession,
  getSessionFromRequest,
  parseCookies,
  serializeCookie,
  signedValue,
  verifySigned,
} from "./session.ts";

export interface AuthDeps {
  storage: Storage;
  oidc: OidcClientOptions;
  env: AuthEnv;
}

interface OidcStatePayload {
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
}

/** Try to handle an auth-related request. Returns null if not an auth route. */
export async function handleAuthRoutes(req: Request, deps: AuthDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/auth/login" && req.method === "GET") {
    return loginRedirect(req, deps);
  }
  if (p === "/auth/callback" && req.method === "GET") {
    return callback(req, deps);
  }
  if (p === "/auth/logout" && (req.method === "POST" || req.method === "GET")) {
    return logout(req, deps);
  }
  if (p === "/api/me" && req.method === "GET") {
    return me(req, deps);
  }
  return null;
}

async function loginRedirect(req: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const returnTo = url.searchParams.get("return_to") || "/";
  const state = randomToken(16);
  const nonce = randomToken(16);
  const { verifier } = generatePkce();
  const payload: OidcStatePayload = { state, nonce, code_verifier: verifier, return_to: returnTo };
  const cookieVal = signedValue(Buffer.from(JSON.stringify(payload)).toString("base64"), deps.env.sessionSecret);

  const authUrl = await buildAuthorizeUrl(deps.oidc, { state, nonce, code_verifier: verifier });
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      "Set-Cookie": serializeCookie(OIDC_STATE_COOKIE, cookieVal, {
        maxAgeMs: OIDC_STATE_TTL_MS,
        httpOnly: true,
        sameSite: "Lax",
        secure: deps.env.cookieSecure,
      }),
    },
  });
}

async function callback(req: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return textResponse(`OIDC error: ${err} ${url.searchParams.get("error_description") ?? ""}`, 400);
  if (!code || !state) return textResponse("Missing code or state", 400);

  const cookies = parseCookies(req.headers.get("cookie"));
  const raw = cookies[OIDC_STATE_COOKIE];
  if (!raw) return textResponse("Missing handshake cookie (login flow timed out or cookies disabled).", 400);
  const verified = verifySigned(raw, deps.env.sessionSecret);
  if (!verified) return textResponse("Invalid handshake cookie signature.", 400);

  let payload: OidcStatePayload;
  try {
    payload = JSON.parse(Buffer.from(verified, "base64").toString("utf8"));
  } catch {
    return textResponse("Corrupt handshake cookie.", 400);
  }
  if (payload.state !== state) return textResponse("State mismatch — possible CSRF.", 400);

  const tokens = await exchangeCode(deps.oidc, code, payload.code_verifier);
  const ui = await fetchUserinfo(deps.oidc, tokens.access_token);

  const user = deps.storage.upsertUser({
    id: ui.sub,
    email: ui.email,
    name: ui.name ?? ui.preferred_username,
  });

  const sessionId = createNewSession(deps.storage, user.id);
  const signed = signedValue(sessionId, deps.env.sessionSecret);

  const headers = new Headers();
  // Two Set-Cookie headers: clear handshake, set session.
  headers.append(
    "Set-Cookie",
    clearedCookie(OIDC_STATE_COOKIE, { secure: deps.env.cookieSecure }),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, signed, {
      maxAgeMs: SESSION_TTL_MS,
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.env.cookieSecure,
    }),
  );
  // Redirect to safe relative return_to
  const target = safeReturnTo(payload.return_to);
  headers.set("Location", target);
  return new Response(null, { status: 302, headers });
}

async function logout(req: Request, deps: AuthDeps): Promise<Response> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const raw = cookies[SESSION_COOKIE];
  if (raw) {
    const sid = verifySigned(raw, deps.env.sessionSecret);
    if (sid) deps.storage.deleteSession(sid);
  }
  const headers = new Headers();
  headers.append("Set-Cookie", clearedCookie(SESSION_COOKIE, { secure: deps.env.cookieSecure }));
  // For GET → redirect to root; for POST → return 200
  if (req.method === "GET") {
    headers.set("Location", "/");
    return new Response(null, { status: 302, headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function me(req: Request, deps: AuthDeps): Promise<Response> {
  const sess = getSessionFromRequest(req, deps.storage, deps.env);
  if (!sess) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Response(
    JSON.stringify({
      id: sess.user.id,
      email: sess.user.email,
      name: sess.user.name,
    }),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
  );
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function safeReturnTo(p: string): string {
  if (!p || !p.startsWith("/") || p.startsWith("//")) return "/";
  return p;
}
