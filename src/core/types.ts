// Core domain types — single source of truth.
// Implements the three-layer model (Group / Conversation / AgentInstance)
// and the pub-sub event semantics from REQUIREMENTS.md.

// ===== Auth / Multi-tenant =====

export interface User {
  id: string;            // OIDC sub
  email: string | null;
  name: string | null;
  created_at: number;
  last_login_at: number;
}

export interface Session {
  id: string;            // random opaque id (cookie value, after signature strip)
  user_id: string;
  created_at: number;
  expires_at: number;
}

export type ConversationStatus = "pending" | "running" | "paused" | "finished";

export type SpeakerKind = "agent" | "user" | "system";

export type EventKind =
  | "speech"          // agent or user spoke (entered channel)
  | "silence"         // agent self-decided silent (self_only, not broadcast)
  | "user_message"    // alias of speech for user
  | "topic"           // topic introduced / changed
  | "system_note"     // system-generated note (e.g. agent joined / warning)
  | "topic_stalled"   // legacy; no longer emitted
  | "round_start"     // ui_only: a new round just began
  | "round_end";      // ui_only: round finished, content describes result

export interface SpeakerSnapshot {
  kind: SpeakerKind;
  id: string;              // instance_id for agent, user_id for user, "system" for system
  display_name: string;
  agent_definition_id?: string;
  agent_definition_version?: number;
}

export interface Event {
  id: string;
  conversation_id: string;
  seq: number;             // monotonic per conversation
  ts: number;              // unix ms
  speaker: SpeakerSnapshot;
  kind: EventKind;
  content: string;         // may be empty for silence
  address: string[];       // instance_ids that were @'d
  visibility: "all" | "self_only" | "ui_only";
  //   all       → stored, fan-out to every agent's recent_events, broadcast to UI
  //   self_only → stored, fan-out only to the speaker's own recent_events, NOT broadcast to UI
  //   ui_only   → stored, NOT fanned out to any agent (keeps their contexts clean), broadcast to UI
  rendered?: Record<string, string>;  // per-agent pre-rendered string (cache C2/C3)
}

export interface SpeakingPolicy {
  cooldown_turns: number;            // skip K wake cycles after speaking
  talkativeness_hint: string;        // freeform persona modifier
  wake_on: string[];                 // event kinds this agent wakes on; ["*"] = all
  silent_streak_threshold: number;   // after N silent, +1 cooldown
}

export interface CompressionPolicy {
  threshold_ratio: number;           // fraction of max_context to trigger compression
  keep_recent_ratio: number;         // fraction of recent_events to retain
}

export interface ModelParams {
  temperature?: number;
  max_output_tokens?: number;
}

export interface AgentDefinition {
  id: string;
  owner_id: string;                  // user_id of the agent's owner (multi-tenant)
  group_id: string | null;           // legacy / origin hint only; real membership lives in group_members
  version: number;
  display_name: string;
  persona: string;
  provider_binding: string;          // e.g. "deepseek:deepseek-chat"
  model_params: ModelParams;
  speaking_policy: SpeakingPolicy;
  compression_policy: CompressionPolicy;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface Group {
  id: string;
  owner_id: string;                  // user_id (multi-tenant)
  name: string;
  description: string;
  default_config: GroupConfig;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface GroupConfig {
  debounce_ms: number;
  heartbeat_interval_s: number;
  max_wake_per_cycle: number;        // 0 = unlimited
  stalled_threshold_cycles: number;
}

export interface DigestSegment {
  range_seq_from: number;
  range_seq_to: number;
  text: string;                       // first-person summary
  created_at: number;
}

export interface PendingAddress {
  from_speaker_id: string;
  from_display_name: string;
  event_id: string;
  at: number;
}

export interface WorkingMemory {
  system_prompt: string;              // frozen for lifetime of instance
  digest_segments: DigestSegment[];   // append-only
  recent_events: Event[];             // events since last compression
  cooldown_until_seq: number;         // skip until channel seq exceeds this
  pending_addresses: PendingAddress[];
  silent_streak: number;
  total_tokens_in: number;
  total_tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  state_version: number;
}

export interface AgentInstance {
  id: string;
  conversation_id: string;
  definition_snapshot: AgentDefinition;  // frozen copy
  working_memory: WorkingMemory;
  joined_at: number;
  left_at: number | null;
}

export interface Conversation {
  id: string;
  owner_id: string;                    // user_id (multi-tenant)
  group_id: string | null;             // soft ref (group may be deleted)
  group_snapshot: { id: string; name: string };
  topic: string;
  status: ConversationStatus;
  config: GroupConfig;                 // snapshot at creation
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

// LLM provider abstraction

export interface NormalizedMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CacheHint {
  // index range into messages[] that should be marked cacheable
  message_from: number;
  message_to: number;
  ttl_hint?: "ephemeral_5min" | "long";
}

export interface JSONSchema {
  // minimal schema descriptor; providers translate to their own format
  name: string;
  schema: Record<string, unknown>;
}

export interface NormalizedRequest {
  system: string;
  messages: NormalizedMessage[];
  output_schema: JSONSchema;
  cache_hints?: CacheHint[];
  max_output_tokens: number;
  temperature?: number;
  stop?: string[];
}

export interface NormalizedUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface SelfDecideOutput {
  speak: boolean;
  content?: string;
  address?: string[];
}

export interface NormalizedResponse {
  parsed: SelfDecideOutput;
  raw_text: string;
  usage: NormalizedUsage;
  finish_reason: string;
  model: string;
}

export interface ProviderCapabilities {
  supports_cache_hints: boolean;
  supports_structured_output: boolean;
  max_context: number;
}

export interface LLMProvider {
  id: string;                // e.g. "deepseek"
  capabilities(): ProviderCapabilities;
  complete(req: NormalizedRequest, model: string, signal?: AbortSignal): Promise<NormalizedResponse>;
}

// Helpers
export function nowMs(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  // Compact id: prefix + base36 timestamp + 6 random chars
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}
