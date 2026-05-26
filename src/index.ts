// Roundtable entry point.

import { Storage } from "./core/storage.ts";
import { RuntimeManager } from "./core/runtime.ts";
import { bootstrapProviders } from "./providers/registry.ts";
import { startServer } from "./api/server.ts";
import type { AuthDeps } from "./auth/routes.ts";

const PORT = Number(process.env.PORT ?? 3001);
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const DB_PATH = `${DATA_DIR}/roundtable.db`;

console.log("=== Roundtable starting ===");

// ---- Auth / OIDC config ----
const required = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "PUBLIC_BASE_URL", "SESSION_SECRET"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    `[boot] FATAL: missing required env vars: ${missing.join(", ")}\n` +
      `       See .env.example for the full list.`,
  );
  process.exit(1);
}
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL!.replace(/\/$/, "");
const auth: AuthDeps = {
  storage: undefined as any, // filled below
  oidc: {
    issuer: process.env.OIDC_ISSUER!,
    client_id: process.env.OIDC_CLIENT_ID!,
    client_secret: process.env.OIDC_CLIENT_SECRET!,
    redirect_uri: process.env.OIDC_REDIRECT_URI ?? `${PUBLIC_BASE_URL}/auth/callback`,
    scopes: (process.env.OIDC_SCOPES ?? "openid profile email").split(/\s+/).filter(Boolean),
  },
  env: {
    sessionSecret: process.env.SESSION_SECRET!,
    cookieSecure: PUBLIC_BASE_URL.startsWith("https://"),
  },
};

// Provider registry
bootstrapProviders();

// Storage
const storage = new Storage(DB_PATH);
auth.storage = storage;
console.log(`[boot] storage at ${DB_PATH}`);
storage.purgeExpiredSessions();

// Runtime manager
const runtime = new RuntimeManager(storage);
runtime.resumeAll();

// HTTP / WebUI
const server = startServer({ storage, runtime, port: PORT, auth });
console.log(`[boot] server listening on http://localhost:${server.port}`);
console.log(`[boot] OIDC issuer: ${auth.oidc.issuer}`);
console.log(`[boot] OIDC redirect_uri: ${auth.oidc.redirect_uri}`);
console.log(`[boot] DEEPSEEK_API_KEY ${process.env.DEEPSEEK_API_KEY ? "set" : "NOT set — you must export it or write .env"}`);
console.log(`=== Ready ===`);

// Graceful shutdown
const shutdown = () => {
  console.log("\n[boot] shutting down");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
