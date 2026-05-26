// Persistent storage using bun:sqlite.
// Multi-tenant: every group/agent_definition/conversation is owned by a user (OIDC sub).
// All list/get queries are scoped by owner_id — callers MUST pass the current user id.
// Tables: users, sessions, groups, agent_definitions, group_members, conversations,
//         agent_instances, events.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentDefinition,
  AgentInstance,
  Conversation,
  Event,
  Group,
  Session,
  User,
} from "./types.ts";
import { nowMs } from "./types.ts";

const REQUIRED_OWNER_TABLES = ["groups", "agent_definitions", "conversations"];

export class Storage {
  db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.checkCompat();
    this.init();
  }

  /** Refuse to start on a legacy single-user DB. Multi-tenant is a hard cut. */
  private checkCompat() {
    for (const table of REQUIRED_OWNER_TABLES) {
      const exists = this.db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as any;
      if (!exists) continue;
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as any[];
      const hasOwner = cols.some((c) => c.name === "owner_id");
      if (!hasOwner) {
        throw new Error(
          `[storage] Legacy single-user DB detected (table "${table}" missing owner_id). ` +
            `Multi-tenant schema is incompatible. Please remove the data directory and restart:\n` +
            `    rm -f ./data/roundtable.db ./data/roundtable.db-shm ./data/roundtable.db-wal`,
        );
      }
    }
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,              -- OIDC sub
        email TEXT,
        name TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,              -- opaque random session id (cookie payload)
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        default_config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id);

      CREATE TABLE IF NOT EXISTS agent_definitions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        group_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        display_name TEXT NOT NULL,
        persona TEXT NOT NULL,
        provider_binding TEXT NOT NULL,
        model_params TEXT NOT NULL,
        speaking_policy TEXT NOT NULL,
        compression_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_defs_owner ON agent_definitions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_agent_defs_group ON agent_definitions(group_id);

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_gm_agent ON group_members(agent_id);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        group_id TEXT,
        group_snapshot TEXT NOT NULL,
        topic TEXT NOT NULL,
        status TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_id);
      CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);

      CREATE TABLE IF NOT EXISTS agent_instances (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        definition_snapshot TEXT NOT NULL,
        working_memory TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_instances_conv ON agent_instances(conversation_id);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '[]',
        visibility TEXT NOT NULL DEFAULT 'all',
        rendered TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_conv_seq ON events(conversation_id, seq);
    `);
  }

  // ===== Users =====
  upsertUser(u: { id: string; email: string | null; name: string | null }): User {
    const now = nowMs();
    const existing = this.getUser(u.id);
    if (existing) {
      this.db
        .prepare("UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?")
        .run(u.email, u.name, now, u.id);
      return { ...existing, email: u.email, name: u.name, last_login_at: now };
    }
    this.db
      .prepare(
        "INSERT INTO users (id, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(u.id, u.email, u.name, now, now);
    return { id: u.id, email: u.email, name: u.name, created_at: now, last_login_at: now };
  }

  getUser(id: string): User | null {
    const r = this.db.query("SELECT * FROM users WHERE id = ?").get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      created_at: r.created_at,
      last_login_at: r.last_login_at,
    };
  }

  // ===== Sessions =====
  createSession(sessionId: string, userId: string, ttlMs: number): Session {
    const now = nowMs();
    const exp = now + ttlMs;
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, userId, now, exp);
    return { id: sessionId, user_id: userId, created_at: now, expires_at: exp };
  }

  getSession(sessionId: string): Session | null {
    const r = this.db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
    if (!r) return null;
    return {
      id: r.id,
      user_id: r.user_id,
      created_at: r.created_at,
      expires_at: r.expires_at,
    };
  }

  touchSession(sessionId: string, ttlMs: number) {
    this.db
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(nowMs() + ttlMs, sessionId);
  }

  deleteSession(sessionId: string) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  purgeExpiredSessions() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowMs());
  }

  // ===== Groups (owner-scoped) =====
  insertGroup(g: Group) {
    this.db
      .prepare(
        `INSERT INTO groups (id, owner_id, name, description, default_config, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id,
        g.owner_id,
        g.name,
        g.description,
        JSON.stringify(g.default_config),
        g.created_at,
        g.updated_at,
        g.deleted_at,
      );
  }

  listGroups(ownerId: string, includeDeleted = false): Group[] {
    const rows = this.db
      .query(
        `SELECT * FROM groups WHERE owner_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY created_at DESC`,
      )
      .all(ownerId) as any[];
    return rows.map(rowToGroup);
  }

  getGroup(id: string, ownerId: string): Group | null {
    const row = this.db
      .query("SELECT * FROM groups WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as any;
    return row ? rowToGroup(row) : null;
  }

  /** Owner-less lookup, ONLY for internal trusted use (runtime resume etc). */
  getGroupAnyOwner(id: string): Group | null {
    const row = this.db.query("SELECT * FROM groups WHERE id = ?").get(id) as any;
    return row ? rowToGroup(row) : null;
  }

  softDeleteGroup(id: string, ownerId: string): boolean {
    const r = this.db
      .prepare("UPDATE groups SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
      .run(nowMs(), nowMs(), id, ownerId);
    return r.changes > 0;
  }

  // ===== Agent Definitions (owner-scoped) =====
  insertAgentDef(a: AgentDefinition) {
    this.db
      .prepare(
        `INSERT INTO agent_definitions (id, owner_id, group_id, version, display_name, persona, provider_binding, model_params, speaking_policy, compression_policy, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.owner_id,
        a.group_id,
        a.version,
        a.display_name,
        a.persona,
        a.provider_binding,
        JSON.stringify(a.model_params),
        JSON.stringify(a.speaking_policy),
        JSON.stringify(a.compression_policy),
        a.created_at,
        a.updated_at,
        a.deleted_at,
      );
  }

  /** Pool-wide list of all agents owned by user. */
  listAllAgents(ownerId: string, includeDeleted = false): AgentDefinition[] {
    const rows = this.db
      .query(
        `SELECT * FROM agent_definitions WHERE owner_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY created_at DESC`,
      )
      .all(ownerId) as any[];
    return rows.map(rowToAgentDef);
  }

  /** Agents in a given group (group itself must be owned by user). */
  listAgentDefs(groupId: string, ownerId: string, includeDeleted = false): AgentDefinition[] {
    const rows = this.db
      .query(
        `SELECT a.* FROM agent_definitions a
         INNER JOIN group_members gm ON gm.agent_id = a.id
         INNER JOIN groups g ON g.id = gm.group_id
         WHERE gm.group_id = ? AND g.owner_id = ? AND a.owner_id = ? ${includeDeleted ? "" : "AND a.deleted_at IS NULL"}
         ORDER BY gm.added_at ASC`,
      )
      .all(groupId, ownerId, ownerId) as any[];
    return rows.map(rowToAgentDef);
  }

  getAgentDef(id: string, ownerId: string): AgentDefinition | null {
    const row = this.db
      .query("SELECT * FROM agent_definitions WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as any;
    return row ? rowToAgentDef(row) : null;
  }

  softDeleteAgentDef(id: string, ownerId: string): boolean {
    const r = this.db
      .prepare("UPDATE agent_definitions SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
      .run(nowMs(), nowMs(), id, ownerId);
    return r.changes > 0;
  }

  // ===== Group membership (owner-scoped via group ownership) =====
  addGroupMember(groupId: string, agentId: string, ownerId: string): boolean {
    // Verify both group and agent belong to the user before linking.
    const g = this.getGroup(groupId, ownerId);
    const a = this.getAgentDef(agentId, ownerId);
    if (!g || !a) return false;
    const r = this.db
      .prepare("INSERT OR IGNORE INTO group_members (group_id, agent_id, added_at) VALUES (?, ?, ?)")
      .run(groupId, agentId, nowMs());
    return r.changes > 0;
  }

  removeGroupMember(groupId: string, agentId: string, ownerId: string): boolean {
    const g = this.getGroup(groupId, ownerId);
    if (!g) return false;
    this.db
      .prepare("DELETE FROM group_members WHERE group_id = ? AND agent_id = ?")
      .run(groupId, agentId);
    return true;
  }

  /** Groups (owned by user) that contain a given agent. */
  listGroupsForAgent(agentId: string, ownerId: string): Group[] {
    const rows = this.db
      .query(
        `SELECT g.* FROM groups g
         INNER JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.agent_id = ? AND g.owner_id = ? AND g.deleted_at IS NULL
         ORDER BY g.created_at ASC`,
      )
      .all(agentId, ownerId) as any[];
    return rows.map(rowToGroup);
  }

  /** Bump version + updated_at. Existing AgentInstances hold their own snapshots — unaffected. */
  updateAgentDef(
    id: string,
    ownerId: string,
    patch: Partial<
      Pick<
        AgentDefinition,
        | "display_name"
        | "persona"
        | "provider_binding"
        | "model_params"
        | "speaking_policy"
        | "compression_policy"
      >
    >,
  ): AgentDefinition | null {
    const existing = this.getAgentDef(id, ownerId);
    if (!existing) return null;
    const merged: AgentDefinition = {
      ...existing,
      display_name: patch.display_name ?? existing.display_name,
      persona: patch.persona ?? existing.persona,
      provider_binding: patch.provider_binding ?? existing.provider_binding,
      model_params: patch.model_params ?? existing.model_params,
      speaking_policy: patch.speaking_policy ?? existing.speaking_policy,
      compression_policy: patch.compression_policy ?? existing.compression_policy,
      version: existing.version + 1,
      updated_at: nowMs(),
    };
    this.db
      .prepare(
        `UPDATE agent_definitions SET display_name = ?, persona = ?, provider_binding = ?, model_params = ?, speaking_policy = ?, compression_policy = ?, version = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
      )
      .run(
        merged.display_name,
        merged.persona,
        merged.provider_binding,
        JSON.stringify(merged.model_params),
        JSON.stringify(merged.speaking_policy),
        JSON.stringify(merged.compression_policy),
        merged.version,
        merged.updated_at,
        id,
        ownerId,
      );
    return merged;
  }

  // ===== Conversations (owner-scoped) =====
  insertConversation(c: Conversation) {
    this.db
      .prepare(
        `INSERT INTO conversations (id, owner_id, group_id, group_snapshot, topic, status, config, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.owner_id,
        c.group_id,
        JSON.stringify(c.group_snapshot),
        c.topic,
        c.status,
        JSON.stringify(c.config),
        c.created_at,
        c.updated_at,
        c.finished_at,
      );
  }

  listConversations(ownerId: string): Conversation[] {
    const rows = this.db
      .query("SELECT * FROM conversations WHERE owner_id = ? ORDER BY created_at DESC")
      .all(ownerId) as any[];
    return rows.map(rowToConversation);
  }

  getConversation(id: string, ownerId: string): Conversation | null {
    const row = this.db
      .query("SELECT * FROM conversations WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as any;
    return row ? rowToConversation(row) : null;
  }

  /** Owner-less lookup for internal trusted code (runtime resume / runner internals). */
  getConversationAnyOwner(id: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? rowToConversation(row) : null;
  }

  updateConversation(c: Conversation) {
    this.db
      .prepare(
        `UPDATE conversations SET topic = ?, status = ?, config = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
      )
      .run(c.topic, c.status, JSON.stringify(c.config), nowMs(), c.finished_at, c.id);
  }

  listRunningConversations(): Conversation[] {
    const rows = this.db.query("SELECT * FROM conversations WHERE status = 'running'").all() as any[];
    return rows.map(rowToConversation);
  }

  // ===== Agent Instances (owner-scoped via conversation) =====
  insertInstance(i: AgentInstance) {
    this.db
      .prepare(
        `INSERT INTO agent_instances (id, conversation_id, definition_snapshot, working_memory, joined_at, left_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.id,
        i.conversation_id,
        JSON.stringify(i.definition_snapshot),
        JSON.stringify(i.working_memory),
        i.joined_at,
        i.left_at,
      );
  }

  listInstances(conversationId: string): AgentInstance[] {
    const rows = this.db
      .query("SELECT * FROM agent_instances WHERE conversation_id = ? ORDER BY joined_at ASC")
      .all(conversationId) as any[];
    return rows.map(rowToInstance);
  }

  updateInstanceMemory(id: string, wm: AgentInstance["working_memory"]) {
    this.db
      .prepare("UPDATE agent_instances SET working_memory = ? WHERE id = ?")
      .run(JSON.stringify(wm), id);
  }

  // ===== Events =====
  nextSeq(conversationId: string): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE conversation_id = ?")
      .get(conversationId) as any;
    return (row?.s ?? 0) + 1;
  }

  insertEvent(e: Event) {
    this.db
      .prepare(
        `INSERT INTO events (id, conversation_id, seq, ts, speaker, kind, content, address, visibility, rendered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.conversation_id,
        e.seq,
        e.ts,
        JSON.stringify(e.speaker),
        e.kind,
        e.content,
        JSON.stringify(e.address ?? []),
        e.visibility,
        e.rendered ? JSON.stringify(e.rendered) : null,
      );
  }

  listEvents(conversationId: string, sinceSeq = 0): Event[] {
    const rows = this.db
      .query("SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC")
      .all(conversationId, sinceSeq) as any[];
    return rows.map(rowToEvent);
  }
}

// ----- Row mappers -----

function rowToGroup(r: any): Group {
  return {
    id: r.id,
    owner_id: r.owner_id,
    name: r.name,
    description: r.description,
    default_config: JSON.parse(r.default_config),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

function rowToAgentDef(r: any): AgentDefinition {
  return {
    id: r.id,
    owner_id: r.owner_id,
    group_id: r.group_id,
    version: r.version,
    display_name: r.display_name,
    persona: r.persona,
    provider_binding: r.provider_binding,
    model_params: JSON.parse(r.model_params),
    speaking_policy: JSON.parse(r.speaking_policy),
    compression_policy: JSON.parse(r.compression_policy),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

function rowToConversation(r: any): Conversation {
  return {
    id: r.id,
    owner_id: r.owner_id,
    group_id: r.group_id,
    group_snapshot: JSON.parse(r.group_snapshot),
    topic: r.topic,
    status: r.status,
    config: JSON.parse(r.config),
    created_at: r.created_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at,
  };
}

function rowToInstance(r: any): AgentInstance {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    definition_snapshot: JSON.parse(r.definition_snapshot),
    working_memory: JSON.parse(r.working_memory),
    joined_at: r.joined_at,
    left_at: r.left_at,
  };
}

function rowToEvent(r: any): Event {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    seq: r.seq,
    ts: r.ts,
    speaker: JSON.parse(r.speaker),
    kind: r.kind,
    content: r.content,
    address: JSON.parse(r.address),
    visibility: r.visibility,
    rendered: r.rendered ? JSON.parse(r.rendered) : undefined,
  };
}
