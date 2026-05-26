// RuntimeManager — owns all active ConversationRunners.
// Responsible for:
//   - Starting/stopping runners on conversation status changes
//   - Resuming all "running" conversations at process start
//   - Creating conversations + agent instances from a Group

import type {
  AgentDefinition,
  AgentInstance,
  Conversation,
  Event,
  Group,
  GroupConfig,
} from "./types.ts";
import { newId, nowMs } from "./types.ts";
import { Storage } from "./storage.ts";
import { ConversationRunner } from "./runner.ts";
import { buildSystemPrompt, personaBrief } from "./render.ts";

export class RuntimeManager {
  private storage: Storage;
  private runners = new Map<string, ConversationRunner>();
  private uiSubscribers = new Map<string, Set<(e: Event) => void>>();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Restart all running conversations from disk on process boot. */
  resumeAll() {
    const runningConvs = this.storage.listRunningConversations();
    for (const c of runningConvs) {
      this.spawnRunner(c);
    }
    console.log(`[runtime] resumed ${runningConvs.length} running conversations`);
  }

  defaultGroupConfig(): GroupConfig {
    return {
      debounce_ms: 400,
      heartbeat_interval_s: 0, // 0 = disabled; can be enabled per-group
      max_wake_per_cycle: 0,    // 0 = unlimited
      stalled_threshold_cycles: 3,
    };
  }

  /** Create a Conversation, instantiate AgentInstances, persist all, and start runner. */
  createConversation(args: {
    owner_id: string;
    group: Group;
    topic: string;
    participant_def_ids?: string[];
    config?: Partial<GroupConfig>;
  }): { conversation: Conversation; instances: AgentInstance[] } {
    const defs = this.storage.listAgentDefs(args.group.id, args.owner_id, /*includeDeleted*/ false);
    const selected = args.participant_def_ids
      ? defs.filter((d) => args.participant_def_ids!.includes(d.id))
      : defs;
    if (selected.length < 2) {
      throw new Error("Conversation requires at least 2 agent participants.");
    }

    const config: GroupConfig = { ...args.group.default_config, ...(args.config ?? {}) };
    const now = nowMs();

    const conv: Conversation = {
      id: newId("conv"),
      owner_id: args.owner_id,
      group_id: args.group.id,
      group_snapshot: { id: args.group.id, name: args.group.name },
      topic: args.topic,
      status: "running",
      config,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    this.storage.insertConversation(conv);

    // Instantiate agents. Each gets its own working_memory and a frozen system prompt
    // that references the other participants as peers.
    const instances: AgentInstance[] = [];
    // First pass: allocate instance IDs so peers list can reference them.
    const instanceIds = new Map<string, string>();
    for (const def of selected) {
      instanceIds.set(def.id, newId("inst"));
    }

    for (const def of selected) {
      const instId = instanceIds.get(def.id)!;
      const peers = selected
        .filter((d) => d.id !== def.id)
        .map((d) => ({
          id: instanceIds.get(d.id)!,
          display_name: d.display_name,
          persona_brief: personaBrief(d.persona),
        }));

      const systemPrompt = buildSystemPrompt({
        self_display_name: def.display_name,
        self_persona: def.persona,
        group_name: args.group.name,
        topic: args.topic,
        peers,
      });

      const inst: AgentInstance = {
        id: instId,
        conversation_id: conv.id,
        definition_snapshot: structuredClone(def),
        working_memory: {
          system_prompt: systemPrompt,
          digest_segments: [],
          recent_events: [],
          cooldown_until_seq: 0,
          pending_addresses: [],
          silent_streak: 0,
          total_tokens_in: 0,
          total_tokens_out: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          state_version: 0,
        },
        joined_at: now,
        left_at: null,
      };
      this.storage.insertInstance(inst);
      instances.push(inst);
    }

    const runner = this.spawnRunner(conv, instances);
    // Seed: post the topic as the first system event so agents see something.
    runner.changeTopic(args.topic);

    return { conversation: conv, instances };
  }

  /** Get or create runner for a conversation. */
  getRunner(convId: string): ConversationRunner | null {
    return this.runners.get(convId) ?? null;
  }

  private spawnRunner(conv: Conversation, instances?: AgentInstance[]): ConversationRunner {
    const insts = instances ?? this.storage.listInstances(conv.id);
    const runner = new ConversationRunner(conv, this.storage, insts, {
      onEventForUi: (e) => this.broadcastToUi(conv.id, e),
    });
    runner.start();
    this.runners.set(conv.id, runner);
    return runner;
  }

  pause(convId: string) {
    const conv = this.storage.getConversationAnyOwner(convId);
    if (!conv) throw new Error("conversation not found");
    conv.status = "paused";
    conv.updated_at = nowMs();
    this.storage.updateConversation(conv);
    const runner = this.runners.get(convId);
    if (runner) {
      runner.stop();
      this.runners.delete(convId);
    }
  }

  resume(convId: string) {
    const conv = this.storage.getConversationAnyOwner(convId);
    if (!conv) throw new Error("conversation not found");
    if (conv.status === "running") return;
    conv.status = "running";
    conv.updated_at = nowMs();
    this.storage.updateConversation(conv);
    this.spawnRunner(conv);
  }

  finish(convId: string) {
    const conv = this.storage.getConversationAnyOwner(convId);
    if (!conv) throw new Error("conversation not found");
    conv.status = "finished";
    conv.finished_at = nowMs();
    conv.updated_at = conv.finished_at;
    this.storage.updateConversation(conv);
    const runner = this.runners.get(convId);
    if (runner) {
      runner.stop();
      this.runners.delete(convId);
    }
  }

  // ---- UI subscription multiplexing ----
  subscribeUi(convId: string, fn: (e: Event) => void): () => void {
    let set = this.uiSubscribers.get(convId);
    if (!set) {
      set = new Set();
      this.uiSubscribers.set(convId, set);
    }
    set.add(fn);
    return () => {
      const s = this.uiSubscribers.get(convId);
      if (s) {
        s.delete(fn);
        if (s.size === 0) this.uiSubscribers.delete(convId);
      }
    };
  }

  private broadcastToUi(convId: string, e: Event) {
    const set = this.uiSubscribers.get(convId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(e);
      } catch (err) {
        console.error("[runtime] ui subscriber error:", err);
      }
    }
  }
}
