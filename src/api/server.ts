// HTTP API + SSE + static WebUI server using Bun.serve.
// Multi-tenant: all /api/* routes require an authenticated session.
// /auth/* routes handle OIDC login/callback/logout.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, Group, User } from "../core/types.ts";
import { newId, nowMs } from "../core/types.ts";
import { Storage } from "../core/storage.ts";
import { RuntimeManager } from "../core/runtime.ts";
import { handleAuthRoutes, type AuthDeps } from "../auth/routes.ts";
import { getSessionFromRequest } from "../auth/session.ts";

const WEB_DIR = new URL("../web/", import.meta.url).pathname;

export interface ServerArgs {
  storage: Storage;
  runtime: RuntimeManager;
  port: number;
  auth: AuthDeps;
}

export function startServer(args: ServerArgs) {
  const { storage, runtime, port, auth } = args;

  return Bun.serve({
    port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      // --- Static files (public) ---
      if (p === "/" || p === "/index.html") {
        return staticFile("index.html", "text/html; charset=utf-8");
      }
      if (p === "/app.js") return staticFile("app.js", "application/javascript; charset=utf-8");
      if (p === "/style.css") return staticFile("style.css", "text/css; charset=utf-8");

      // --- Auth routes (public + /api/me which handles its own 401) ---
      const authRes = await handleAuthRoutes(req, auth);
      if (authRes) return authRes;

      // --- All /api/* require a session ---
      if (!p.startsWith("/api/")) {
        return json({ error: "not found", path: p }, 404);
      }

      const sess = getSessionFromRequest(req, storage, auth.env);
      if (!sess) {
        return json({ error: "unauthenticated", login_url: "/auth/login" }, 401);
      }
      const user = sess.user;

      try {
        if (p === "/api/health" && req.method === "GET") {
          return json({ ok: true, ts: nowMs() });
        }

        // Groups
        if (p === "/api/groups" && req.method === "GET") {
          return json(storage.listGroups(user.id));
        }
        if (p === "/api/groups" && req.method === "POST") {
          const body = await req.json();
          return json(createGroup(storage, body, user));
        }
        const mGroup = p.match(/^\/api\/groups\/([^\/]+)$/);
        if (mGroup && req.method === "GET") {
          const g = storage.getGroup(mGroup[1]!, user.id);
          if (!g) return json({ error: "not found" }, 404);
          const agents = storage.listAgentDefs(g.id, user.id);
          return json({ ...g, agents });
        }
        if (mGroup && req.method === "DELETE") {
          const ok = storage.softDeleteGroup(mGroup[1]!, user.id);
          if (!ok) return json({ error: "not found" }, 404);
          return json({ ok: true });
        }
        const mGroupAgents = p.match(/^\/api\/groups\/([^\/]+)\/agents$/);
        if (mGroupAgents && req.method === "POST") {
          // Create a new agent IN THE POOL and add it to this group.
          const g = storage.getGroup(mGroupAgents[1]!, user.id);
          if (!g) return json({ error: "group not found" }, 404);
          const body = await req.json();
          const a = createAgentDef(storage, body, g.id, user);
          storage.addGroupMember(g.id, a.id, user.id);
          return json(a);
        }

        // Group membership
        const mGroupMembers = p.match(/^\/api\/groups\/([^\/]+)\/members$/);
        if (mGroupMembers && req.method === "POST") {
          const body = await req.json();
          if (!body.agent_id) return json({ error: "agent_id required" }, 400);
          const added = storage.addGroupMember(mGroupMembers[1]!, body.agent_id, user.id);
          if (!added) return json({ error: "group or agent not found / not yours" }, 404);
          return json({ ok: true, added });
        }
        const mGroupMember = p.match(/^\/api\/groups\/([^\/]+)\/members\/([^\/]+)$/);
        if (mGroupMember && req.method === "DELETE") {
          const ok = storage.removeGroupMember(mGroupMember[1]!, mGroupMember[2]!, user.id);
          if (!ok) return json({ error: "group not found" }, 404);
          return json({ ok: true });
        }

        // ----- Agent pool -----
        if (p === "/api/agents" && req.method === "GET") {
          return json(storage.listAllAgents(user.id));
        }
        if (p === "/api/agents" && req.method === "POST") {
          const body = await req.json();
          return json(createAgentDef(storage, body, null, user));
        }
        const mAgent = p.match(/^\/api\/agents\/([^\/]+)$/);
        if (mAgent && req.method === "GET") {
          const a = storage.getAgentDef(mAgent[1]!, user.id);
          if (!a) return json({ error: "not found" }, 404);
          const groups = storage.listGroupsForAgent(a.id, user.id);
          return json({ ...a, groups: groups.map((g) => ({ id: g.id, name: g.name })) });
        }
        if (mAgent && req.method === "PATCH") {
          const body = await req.json();
          const updated = storage.updateAgentDef(mAgent[1]!, user.id, body);
          if (!updated) return json({ error: "agent not found" }, 404);
          return json(updated);
        }
        if (mAgent && req.method === "DELETE") {
          const ok = storage.softDeleteAgentDef(mAgent[1]!, user.id);
          if (!ok) return json({ error: "not found" }, 404);
          return json({ ok: true });
        }
        const mDelAgent = p.match(/^\/api\/groups\/([^\/]+)\/agents\/([^\/]+)$/);
        if (mDelAgent && req.method === "DELETE") {
          const ok = storage.removeGroupMember(mDelAgent[1]!, mDelAgent[2]!, user.id);
          if (!ok) return json({ error: "group not found" }, 404);
          return json({ ok: true });
        }
        if (mDelAgent && req.method === "PATCH") {
          const body = await req.json();
          const updated = storage.updateAgentDef(mDelAgent[2]!, user.id, body);
          if (!updated) return json({ error: "agent not found" }, 404);
          return json(updated);
        }
        if (mDelAgent && req.method === "GET") {
          const a = storage.getAgentDef(mDelAgent[2]!, user.id);
          if (!a) return json({ error: "not found" }, 404);
          return json(a);
        }

        // Conversations
        if (p === "/api/conversations" && req.method === "GET") {
          const convs = storage.listConversations(user.id);
          const enriched = convs.map((c) => {
            const insts = storage.listInstances(c.id);
            return {
              ...c,
              participants: insts.map((i) => ({
                id: i.id,
                name: i.definition_snapshot.display_name,
              })),
            };
          });
          return json(enriched);
        }
        if (p === "/api/conversations" && req.method === "POST") {
          const body = await req.json();
          const g = storage.getGroup(body.group_id, user.id);
          if (!g) return json({ error: "group not found" }, 404);
          const result = runtime.createConversation({
            owner_id: user.id,
            group: g,
            topic: body.topic,
            participant_def_ids: body.participant_def_ids,
            config: body.config,
          });
          return json({
            conversation: result.conversation,
            participants: result.instances.map((i) => ({
              id: i.id,
              name: i.definition_snapshot.display_name,
            })),
          });
        }
        const mConv = p.match(/^\/api\/conversations\/([^\/]+)$/);
        if (mConv && req.method === "GET") {
          const c = storage.getConversation(mConv[1]!, user.id);
          if (!c) return json({ error: "not found" }, 404);
          const insts = storage.listInstances(c.id);
          const runner = runtime.getRunner(c.id);
          return json({
            ...c,
            round_active: runner ? runner.isRoundActive() : false,
            participants: insts.map((i) => ({
              id: i.id,
              name: i.definition_snapshot.display_name,
              persona: i.definition_snapshot.persona,
              tokens_in: i.working_memory.total_tokens_in,
              tokens_out: i.working_memory.total_tokens_out,
              cache_read: i.working_memory.cache_read_tokens,
              cache_write: i.working_memory.cache_write_tokens,
              digest_segments: i.working_memory.digest_segments.length,
              recent_event_count: i.working_memory.recent_events.length,
            })),
          });
        }
        const mEvents = p.match(/^\/api\/conversations\/([^\/]+)\/events$/);
        if (mEvents && req.method === "GET") {
          const convId = mEvents[1]!;
          const conv = storage.getConversation(convId, user.id);
          if (!conv) return json({ error: "not found" }, 404);
          const accept = req.headers.get("accept") ?? "";
          if (accept.includes("text/event-stream")) {
            return sseEvents(runtime, storage, convId);
          }
          const sinceSeq = Number(url.searchParams.get("since") ?? "0");
          const includePrivate = url.searchParams.get("include_private") === "1";
          let events = storage.listEvents(convId, sinceSeq);
          if (!includePrivate) events = events.filter((e) => e.visibility !== "self_only");
          return json(events);
        }
        const mMsg = p.match(/^\/api\/conversations\/([^\/]+)\/messages$/);
        if (mMsg && req.method === "POST") {
          const convId = mMsg[1]!;
          const conv = storage.getConversation(convId, user.id);
          if (!conv) return json({ error: "not found" }, 404);
          const runner = runtime.getRunner(convId);
          if (!runner) return json({ error: "conversation not running" }, 400);
          const body = await req.json();
          runner.injectUserMessage(
            body.content ?? "",
            body.user_name ?? user.name ?? "用户",
            user.id,
            Array.isArray(body.address) ? body.address : undefined,
          );
          return json({ ok: true });
        }

        // Owner-scoped conversation control routes
        for (const action of ["pause", "resume", "finish", "poke", "stop", "topic"] as const) {
          const m = p.match(new RegExp(`^/api/conversations/([^/]+)/${action}$`));
          if (m && req.method === "POST") {
            const convId = m[1]!;
            const conv = storage.getConversation(convId, user.id);
            if (!conv) return json({ error: "not found" }, 404);
            switch (action) {
              case "pause":
                runtime.pause(convId);
                return json({ ok: true });
              case "resume":
                runtime.resume(convId);
                return json({ ok: true });
              case "finish":
                runtime.finish(convId);
                return json({ ok: true });
              case "poke": {
                const r = runtime.getRunner(convId);
                if (!r) return json({ error: "conversation not running" }, 400);
                r.poke();
                return json({ ok: true });
              }
              case "stop": {
                const r = runtime.getRunner(convId);
                if (!r) return json({ error: "conversation not running" }, 400);
                r.stopCurrentRound();
                return json({ ok: true });
              }
              case "topic": {
                const r = runtime.getRunner(convId);
                if (!r) return json({ error: "conversation not running" }, 400);
                const body = await req.json();
                r.changeTopic(body.topic ?? "");
                return json({ ok: true });
              }
            }
          }
        }

        return json({ error: "not found", path: p }, 404);
      } catch (err: any) {
        console.error("[api] error:", err);
        return json({ error: err?.message ?? "internal error" }, 500);
      }
    },
  });
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function staticFile(name: string, contentType: string): Response {
  try {
    const data = readFileSync(join(WEB_DIR, name));
    return new Response(data, { headers: { "Content-Type": contentType } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

function sseEvents(runtime: RuntimeManager, storage: Storage, convId: string): Response {
  // Caller already verified the conversation belongs to the current user.
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const historical = storage.listEvents(convId, 0).filter((e) => e.visibility !== "self_only");
      for (const e of historical) {
        controller.enqueue(enc.encode(`event: event\ndata: ${JSON.stringify(e)}\n\n`));
      }
      controller.enqueue(enc.encode(`event: history_end\ndata: {}\n\n`));

      const unsubscribe = runtime.subscribeUi(convId, (e) => {
        try {
          controller.enqueue(enc.encode(`event: event\ndata: ${JSON.stringify(e)}\n\n`));
        } catch {
          // closed
        }
      });

      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          // closed
        }
      }, 25_000);

      (controller as any)._cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
    },
    cancel() {
      const c = this as any;
      if (c._cleanup) c._cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---- Group / Agent creation helpers ----

function createGroup(storage: Storage, body: any, user: User): Group {
  const now = nowMs();
  const g: Group = {
    id: newId("grp"),
    owner_id: user.id,
    name: body.name ?? "未命名群组",
    description: body.description ?? "",
    default_config: body.default_config ?? {
      debounce_ms: 400,
      heartbeat_interval_s: 0,
      max_wake_per_cycle: 0,
      stalled_threshold_cycles: 3,
    },
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  storage.insertGroup(g);
  return g;
}

function createAgentDef(
  storage: Storage,
  body: any,
  groupId: string | null,
  user: User,
): AgentDefinition {
  const now = nowMs();
  const a: AgentDefinition = {
    id: newId("agt"),
    owner_id: user.id,
    group_id: groupId,
    version: 1,
    display_name: body.display_name ?? "无名 Agent",
    persona: body.persona ?? "",
    provider_binding: body.provider_binding ?? "deepseek:deepseek-chat",
    model_params: body.model_params ?? { temperature: 0.7, max_output_tokens: 600 },
    speaking_policy: body.speaking_policy ?? {
      cooldown_turns: 1,
      talkativeness_hint: "balanced",
      wake_on: ["*"],
      silent_streak_threshold: 3,
    },
    compression_policy: body.compression_policy ?? {
      threshold_ratio: 0.6,
      keep_recent_ratio: 0.3,
    },
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  storage.insertAgentDef(a);
  return a;
}
