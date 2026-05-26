// Per-conversation runner — STRICT ROUND-BASED MODEL.
//
// Interaction logic (replaces the old continuous pub-sub model):
//
//   Round 1:
//     - External trigger (user message / topic / poke) is fanned out to all
//       agents' working_memory IMMEDIATELY and persisted/UI-shown.
//     - All non-deleted agents are called in PARALLEL.
//     - As each agent produces a speech, that speech is persisted and
//       broadcast to the UI — but NOT fanned out to other agents yet.
//     - Silences are private (self_only) and don't reach UI or peers.
//
//   End of round:
//     - All speeches produced this round are batch-flushed to every agent's
//       recent_events in a single shot. This prevents the "one agent's words
//       trigger another to wake mid-round" cascade.
//     - Any queued external events (user/topic that arrived mid-round) flush
//       at the same time.
//
//   Trigger next round?
//     - If ≥1 agent spoke this round, automatically start round 2 with a
//       follow-up hint ("speak only if inspired; else stay silent").
//     - If a pending external trigger exists, start next round.
//     - Else: discussion is idle. No more LLM calls until the user acts.
//
// Net effect: per round, every agent gets exactly one LLM call. Rounds end
// naturally. No hidden polling. No cascading retriggers within a round.

import type {
  AgentInstance,
  Conversation,
  Event,
  EventKind,
  PendingAddress,
  SelfDecideOutput,
  SpeakerSnapshot,
} from "./types.ts";
import { newId, nowMs } from "./types.ts";
import { Storage } from "./storage.ts";
import { EventBus } from "./eventbus.ts";
import { assembleMessages, renderEventChunk } from "./render.ts";
import { resolveBinding } from "../providers/registry.ts";
import { compressIfNeeded } from "./compression.ts";

export interface RunnerCallbacks {
  onEventForUi?: (e: Event) => void;
}

export class ConversationRunner {
  readonly conversation: Conversation;
  private storage: Storage;
  private bus = new EventBus();
  private instances: AgentInstance[] = [];
  private callbacks: RunnerCallbacks;

  private roundNumber = 0;
  private running = false;

  // Round orchestration
  private runningRound = false;
  private pendingTrigger = false;
  // AbortController for the currently-running round. Calling abort() cancels
  // all in-flight LLM calls in this round; the runner then short-circuits
  // out of the round loop.
  private currentRoundAbort: AbortController | null = null;
  // Events that arrived during a running round and should be flushed to all
  // agents at round end (along with this round's own speeches).
  private deferredFanOut: Event[] = [];

  constructor(
    conv: Conversation,
    storage: Storage,
    instances: AgentInstance[],
    callbacks: RunnerCallbacks = {},
  ) {
    this.conversation = conv;
    this.storage = storage;
    this.instances = instances;
    this.callbacks = callbacks;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // UI subscriber only. Agent fan-out is handled explicitly at round
    // boundaries — NOT via the bus. The bus is now a pure UI broadcast channel.
    if (this.callbacks.onEventForUi) {
      const uiCb = this.callbacks.onEventForUi;
      this.bus.subscribe((e) => {
        if (e.visibility === "self_only") return;
        uiCb(e);
      });
    }
    console.log(
      `[runner ${this.conversation.id}] started with ${this.instances.length} agents (round-based mode)`,
    );
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    console.log(`[runner ${this.conversation.id}] stopped`);
  }

  subscribeUi(fn: (e: Event) => void): () => void {
    return this.bus.subscribe(fn);
  }

  /** Public: is a round currently running? */
  isRoundActive(): boolean {
    return this.runningRound;
  }

  /** Public: force-cancel the currently running round. In-flight LLM calls
   *  are aborted (their network requests are killed). The round flushes
   *  whatever speeches did make it before the abort, then the runner stops. */
  stopCurrentRound() {
    if (!this.runningRound) return;
    if (this.currentRoundAbort) {
      console.log(`[runner ${this.conversation.id}] ✋ stopCurrentRound: aborting in-flight LLM calls`);
      this.currentRoundAbort.abort();
    }
    // Also clear pending trigger so no follow-up round starts.
    this.pendingTrigger = false;
  }

  /** Inject a user message. Triggers a round (or queues if one is running). */
  injectUserMessage(content: string, userDisplayName: string, userId: string, address?: string[]) {
    const ev = this.buildEvent({
      speaker: { kind: "user", id: userId, display_name: userDisplayName },
      kind: "user_message",
      content,
      address: address ?? [],
      visibility: "all",
    });
    this.persistAndShowUi(ev);
    this.triggerWithExternalEvent(ev);
  }

  /** Force a round to start (regardless of any new external event). */
  poke() {
    if (!this.running || this.conversation.status !== "running") return;
    if (this.runningRound) {
      this.pendingTrigger = true;
      return;
    }
    this.runRoundsUntilIdle("poke").catch((err) =>
      console.error(`[runner ${this.conversation.id}] poke error:`, err),
    );
  }

  /** Update the topic (records a topic event + triggers a round). */
  changeTopic(newTopic: string) {
    this.conversation.topic = newTopic;
    this.conversation.updated_at = nowMs();
    this.storage.updateConversation(this.conversation);
    const ev = this.buildEvent({
      speaker: { kind: "system", id: "system", display_name: "system" },
      kind: "topic",
      content: newTopic,
      address: [],
      visibility: "all",
    });
    this.persistAndShowUi(ev);
    this.triggerWithExternalEvent(ev);
  }

  // ===================================================================
  // Internal
  // ===================================================================

  /**
   * An external event (user msg / topic) just landed. It must reach all
   * agent contexts BEFORE they think, since it's the trigger.
   *
   * - If no round is running: fan it out immediately and start a round.
   * - If a round is running: defer fan-out to the end of the current round
   *   (so mid-round agent calls see consistent context), and schedule a
   *   subsequent round.
   */
  private triggerWithExternalEvent(ev: Event) {
    if (!this.running || this.conversation.status !== "running") return;
    if (this.runningRound) {
      this.deferredFanOut.push(ev);
      this.pendingTrigger = true;
      return;
    }
    // No round in flight: fan out the trigger event to all agents NOW.
    this.fanOutEventToAllAgents(ev);
    this.runRoundsUntilIdle("external").catch((err) =>
      console.error(`[runner ${this.conversation.id}] round error:`, err),
    );
  }

  /**
   * Main loop. Runs rounds until a round produces zero speeches and no
   * pending external trigger remains.
   */
  private async runRoundsUntilIdle(initialReason: string) {
    if (this.runningRound) return;
    this.runningRound = true;
    let reason = initialReason;
    try {
      while (true) {
        if (!this.running || this.conversation.status !== "running") break;
        const candidates = this.instances.filter((i) => i.left_at === null);
        if (candidates.length === 0) break;

        this.roundNumber += 1;
        const round = this.roundNumber;
        this.currentRoundAbort = new AbortController();
        const signal = this.currentRoundAbort.signal;

        console.log(
          `[runner ${this.conversation.id}] ▶ round#${round} reason="${reason}" → ${candidates.length} parallel LLM call(s): ${candidates.map((c) => c.definition_snapshot.display_name).join(", ")}`,
        );

        // Emit UI marker so the chat shows a round header divider.
        this.persistAndShowUi(this.buildEvent({
          speaker: { kind: "system", id: "system", display_name: "system" },
          kind: "round_start",
          content: `Round ${round}`,
          address: [],
          visibility: "ui_only",
        }));

        // Snapshot pending addresses for prompt hints; clear after this round.
        const addressedByPerInstance = candidates.map((inst) =>
          inst.working_memory.pending_addresses.map((p) => p.from_display_name),
        );

        // Parallel self-decide for all agents this round.
        const roundSpeeches: Event[] = [];
        const spokeNames: string[] = [];
        const silentNames: string[] = [];

        const results = await Promise.all(
          candidates.map((inst, idx) =>
            this.selfDecideAndPublish(
              inst, round, addressedByPerInstance[idx]!,
              roundSpeeches, spokeNames, silentNames, signal,
            ),
          ),
        );
        void results;

        const aborted = signal.aborted;
        const roundResultLabel = aborted
          ? `Round ${round} · 已被强制停止 (${spokeNames.length} 人在终止前发言)`
          : spokeNames.length > 0
            ? `Round ${round} · ${spokeNames.length} 人发言`
            : `Round ${round} · 无人回应，本轮完成`;

        console.log(
          `[runner ${this.conversation.id}] ◀ round#${round} done${aborted ? " (ABORTED)" : ""}. spoke=[${spokeNames.join(",") || "-"}] silent=[${silentNames.join(",") || "-"}]`,
        );

        // Emit UI marker for round end (with result label).
        this.persistAndShowUi(this.buildEvent({
          speaker: { kind: "system", id: "system", display_name: "system" },
          kind: "round_end",
          content: roundResultLabel,
          address: [],
          visibility: "ui_only",
        }));

        // Flush this round's speeches + any deferred external events to all
        // agents' working memory in one consistent batch. Even on abort, we
        // flush whatever speeches did complete before the abort fired — those
        // are real history.
        const toFanOut: Event[] = [...this.deferredFanOut, ...roundSpeeches];
        this.deferredFanOut = [];
        if (toFanOut.length > 0) {
          for (const ev of toFanOut) {
            this.fanOutEventToAllAgents(ev);
          }
        }

        // Per-agent compression check after fan-out (skip if aborted to fail fast).
        if (!aborted) {
          for (const inst of candidates) {
            try {
              const { provider } = resolveBinding(inst.definition_snapshot.provider_binding);
              const compressed = await compressIfNeeded(inst, provider.capabilities().max_context);
              if (compressed) {
                this.storage.updateInstanceMemory(inst.id, inst.working_memory);
                console.log(`[runner ${this.conversation.id}] compressed memory for ${inst.definition_snapshot.display_name}`);
              }
            } catch (err) {
              console.error(`[runner ${this.conversation.id}] compression error:`, err);
            }
          }
        }

        this.currentRoundAbort = null;

        // Decide whether to start another round.
        if (aborted) {
          console.log(`[runner ${this.conversation.id}] ☾ stopped by user — no follow-up round`);
          break;
        }
        const anySpoke = spokeNames.length > 0;
        if (this.pendingTrigger) {
          this.pendingTrigger = false;
          reason = "external-during-round";
          continue;
        }
        if (anySpoke) {
          reason = "followup";
          continue;
        }
        // Zero speeches and no external trigger ⇒ discussion is idle.
        console.log(`[runner ${this.conversation.id}] ☾ idle — no follow-up round`);
        break;
      }
    } finally {
      this.runningRound = false;
      this.currentRoundAbort = null;
    }
  }

  /**
   * Run a single agent's self-decide LLM call and, if it spoke, persist +
   * broadcast to UI immediately (but do NOT fan out to other agents).
   * Honors the abort signal — if aborted before the response returns, the
   * agent is treated as having gone silent for this round.
   */
  private async selfDecideAndPublish(
    inst: AgentInstance,
    round: number,
    addressed_by: string[],
    roundSpeeches: Event[],
    spokeNames: string[],
    silentNames: string[],
    signal: AbortSignal,
  ): Promise<void> {
    let out: SelfDecideOutput | null = null;
    try {
      const { provider, model } = resolveBinding(inst.definition_snapshot.provider_binding);
      const messages = assembleMessages(inst, round, addressed_by);
      const resp = await provider.complete(
        {
          system: inst.working_memory.system_prompt,
          messages,
          output_schema: {
            name: "self_decide",
            schema: {
              type: "object",
              required: ["speak"],
              properties: {
                speak: { type: "boolean" },
                content: { type: "string" },
                address: { type: "array", items: { type: "string" } },
              },
            },
          },
          max_output_tokens: inst.definition_snapshot.model_params.max_output_tokens ?? 600,
          temperature: inst.definition_snapshot.model_params.temperature ?? 0.7,
        },
        model,
        signal,
      );
      inst.working_memory.total_tokens_in += resp.usage.input;
      inst.working_memory.total_tokens_out += resp.usage.output;
      inst.working_memory.cache_read_tokens += resp.usage.cache_read;
      inst.working_memory.cache_write_tokens += resp.usage.cache_write;
      out = resp.parsed;
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        // Round was force-stopped while this agent's call was in flight.
        // Treat as silent and skip persistence.
        console.log(`[runner ${this.conversation.id}] ⛔ ${inst.definition_snapshot.display_name} aborted mid-call`);
        out = null;
      } else {
        console.error(
          `[runner ${this.conversation.id}] selfDecide error for ${inst.definition_snapshot.display_name}:`,
          err,
        );
        out = null;
      }
    }

    // Clear pending addresses (delivered this round)
    inst.working_memory.pending_addresses = [];
    inst.working_memory.state_version += 1;

    if (out && out.speak && out.content && out.content.trim().length > 0) {
      spokeNames.push(inst.definition_snapshot.display_name);
      const addr = filterValidAddresses(out.address ?? [], this.instances, inst.id);
      const ev = this.buildEvent({
        speaker: {
          kind: "agent",
          id: inst.id,
          display_name: inst.definition_snapshot.display_name,
          agent_definition_id: inst.definition_snapshot.id,
          agent_definition_version: inst.definition_snapshot.version,
        },
        kind: "speech",
        content: out.content.trim(),
        address: addr,
        visibility: "all",
      });
      this.persistAndShowUi(ev);
      roundSpeeches.push(ev);
      inst.working_memory.silent_streak = 0;
    } else if (!signal.aborted) {
      // Genuine silence (not abort-induced)
      silentNames.push(inst.definition_snapshot.display_name);
      this.recordSilence(inst);
      inst.working_memory.silent_streak += 1;
    }
    this.storage.updateInstanceMemory(inst.id, inst.working_memory);
  }

  /**
   * Persist an event to the DB and broadcast it to UI subscribers ONLY.
   * Does NOT fan out to agent working_memory (caller handles that at the
   * appropriate moment for round semantics).
   */
  private persistAndShowUi(ev: Event) {
    // Pre-render for each agent (cache C2/C3) — needed when later fanned out.
    if (ev.visibility !== "ui_only") {
      const rendered: Record<string, string> = {};
      for (const inst of this.instances) {
        rendered[inst.id] = renderEventChunk(ev, inst.id).text;
      }
      ev.rendered = rendered;
    }
    this.storage.insertEvent(ev);
    this.bus.publish(ev); // UI listener only (agent subscriptions removed in start())
  }

  /**
   * Fan out an event into every agent's recent_events AT ROUND BOUNDARY.
   * Updates pending_addresses for @-targeted agents (R2).
   */
  private fanOutEventToAllAgents(ev: Event) {
    if (ev.visibility !== "all") return; // self_only handled in recordSilence; ui_only never reaches agents
    for (const inst of this.instances) {
      if (inst.left_at !== null) continue;
      inst.working_memory.recent_events.push(ev);
      if (
        ev.kind === "speech" &&
        Array.isArray(ev.address) &&
        ev.address.includes(inst.id)
      ) {
        const pa: PendingAddress = {
          from_speaker_id: ev.speaker.id,
          from_display_name: ev.speaker.display_name,
          event_id: ev.id,
          at: ev.ts,
        };
        inst.working_memory.pending_addresses.push(pa);
      }
      inst.working_memory.state_version += 1;
      this.storage.updateInstanceMemory(inst.id, inst.working_memory);
    }
  }

  private recordSilence(inst: AgentInstance) {
    // Silence is the agent's PRIVATE decision: not shown in UI, not delivered
    // to other agents. Stored as self_only for self-continuity audit.
    const ev = this.buildEvent({
      speaker: {
        kind: "agent",
        id: inst.id,
        display_name: inst.definition_snapshot.display_name,
      },
      kind: "silence",
      content: "",
      address: [],
      visibility: "self_only",
    });
    this.storage.insertEvent(ev);
    inst.working_memory.recent_events.push(ev); // self only
    // No bus.publish — UI subscriber filters self_only anyway, but skipping is cheaper.
  }

  private buildEvent(args: {
    speaker: SpeakerSnapshot;
    kind: EventKind;
    content: string;
    address: string[];
    visibility: "all" | "self_only" | "ui_only";
  }): Event {
    const seq = this.storage.nextSeq(this.conversation.id);
    return {
      id: newId("evt"),
      conversation_id: this.conversation.id,
      seq,
      ts: nowMs(),
      speaker: args.speaker,
      kind: args.kind,
      content: args.content,
      address: args.address,
      visibility: args.visibility,
    };
  }
}

function filterValidAddresses(
  raw: string[],
  instances: AgentInstance[],
  selfId: string,
): string[] {
  const valid = new Set(
    instances.filter((i) => i.left_at === null).map((i) => i.id),
  );
  return raw.filter((id) => id !== selfId && valid.has(id));
}
