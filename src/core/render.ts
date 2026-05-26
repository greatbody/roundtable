// Perspective rendering.
//
// Translates the conversation event log into a per-AgentInstance message array.
// Key invariants (see REQUIREMENTS.md §4):
//   C1 Stable prefix / volatile tail
//   C2 Event serialization is immutable (rendered string frozen)
//   C3 Render-on-ingest (stored on the event)
//   C4 No timestamps inside the stable prefix
//   C9 Adjacent "other" events merged within recent-window into a single user message
//
// "Self" = the AgentInstance we are preparing the request for.

import type {
  AgentInstance,
  Conversation,
  Event,
  NormalizedMessage,
} from "./types.ts";

/**
 * Render the system prompt for an AgentInstance.
 * Called once at instance creation and frozen for its lifetime (I2).
 */
export function buildSystemPrompt(args: {
  self_display_name: string;
  self_persona: string;
  group_name: string;
  topic: string;
  peers: { id: string; display_name: string; persona_brief: string }[];
}): string {
  const peersBlock = args.peers
    .map((p) => `  - ${p.display_name} [${p.id}] — ${p.persona_brief}`)
    .join("\n");

  return [
    `<group name="${escapeAttr(args.group_name)}">`,
    `  你正在参与一个多智能体讨论。`,
    `</group>`,
    ``,
    `<topic>${escapeXml(args.topic)}</topic>`,
    ``,
    `<self id="self" display_name="${escapeAttr(args.self_display_name)}">`,
    args.self_persona,
    `</self>`,
    ``,
    `<peers>`,
    `  其他在场的成员（@ 他们时使用方括号内的 id）：`,
    peersBlock || `  （暂无其他成员）`,
    `</peers>`,
    ``,
    `<rules>`,
    `  1. 你完全自主决定是否发言。`,
    `  2. 发言要克制：避免重复别人、空泛附和、冗长展开。每次发言尽量短而有信息量。`,
    `  3. 但克制 ≠ 噤声。当你有从你独特角度（人设里你专长的那块）出发的观点时，应该开口 —— 哪怕只是一两句。`,
    `  4. 沉默的合理场景：你确实没有新观点 / 已被他人完整表达 / 当前话题与你专长完全无关。`,
    `  5. 不合理的沉默：仅仅因为别人讲过相关内容就让步，但你的角度并未被覆盖。`,
    `  6. 仅当你想让某位特定成员回应时才 @。被 @ 不强制对方回应。`,
    `  7. 不存在 @all / @everyone。`,
    `</rules>`,
    ``,
    `<output_format>`,
    `  你的回复必须是严格的 JSON：`,
    `  - 选择沉默：{"speak": false}`,
    `  - 选择发言：{"speak": true, "content": "你的话", "address": ["id1", ...]}`,
    `  - address 数组可省略；若 content 内出现 @id 应同时填入 address。`,
    `</output_format>`,
  ].join("\n");
}

/**
 * Build the digest block as a single user message string.
 * Stable across calls as long as no new digest segment is appended.
 */
export function renderDigest(segments: { text: string; range_seq_from: number; range_seq_to: number }[]): string | null {
  if (segments.length === 0) return null;
  const inner = segments
    .map(
      (s) =>
        `  <segment range="${s.range_seq_from}-${s.range_seq_to}">${escapeXml(s.text)}</segment>`,
    )
    .join("\n");
  return `<digest>\n${inner}\n</digest>`;
}

/**
 * Render a single event into a chunk string as seen by the given self.
 * This output is frozen and cached on the event for reuse (C2/C3).
 */
export function renderEventChunk(e: Event, selfId: string): { isSelf: boolean; text: string } {
  const isSelf = e.speaker.kind === "agent" && e.speaker.id === selfId;
  const addressesYou = Array.isArray(e.address) && e.address.includes(selfId);

  if (e.kind === "speech" || e.kind === "user_message") {
    const speakerName = escapeAttr(e.speaker.display_name);
    const speakerKind = e.speaker.kind;
    const addrAttr = addressesYou ? ` addresses_you="true"` : "";
    const tag = isSelf ? "self" : speakerKind;
    return {
      isSelf,
      text: `<turn speaker="${speakerName}" kind="${tag}"${addrAttr}>${escapeXml(e.content)}</turn>`,
    };
  }

  if (e.kind === "silence") {
    // Only relevant when self (visibility filter ensures we only see our own silences).
    return { isSelf: true, text: `<silence/>` };
  }

  if (e.kind === "topic") {
    return { isSelf: false, text: `<topic_change>${escapeXml(e.content)}</topic_change>` };
  }

  if (e.kind === "system_note") {
    return { isSelf: false, text: `<system_note>${escapeXml(e.content)}</system_note>` };
  }

  return { isSelf: false, text: `<event kind="${e.kind}">${escapeXml(e.content)}</event>` };
}

/**
 * Build the trigger segment (the volatile tail). Keep it small (C6).
 * Round-aware: round 1 invites the agent's initial take from its own angle;
 * rounds 2+ ask whether the agent has a *distinct* perspective to add.
 *
 * Important: we do NOT pile "stay silent" warnings here. The persona and the
 * system prompt already enforce restraint. Over-stacking silence guidance
 * empirically makes well-mannered personas freeze on round 1.
 */
export function buildTrigger(args: {
  round: number;
  addressed_by: string[];
}): string {
  const addressedAttr =
    args.addressed_by.length > 0
      ? ` addressed_by="${args.addressed_by.map(escapeAttr).join(",")}"`
      : "";
  let body: string;
  if (args.round <= 1) {
    body = [
      `  这是第 1 轮。话题刚抛出，没有其他人发言。`,
      `  请基于你的专业视角给出你的初步看法 —— 哪怕只是简短一句"我从 X 角度看到 Y"。`,
      `  仅当你判断"此话题完全不涉及我的专业、无任何贡献可言"时，才输出 {"speak": false}。`,
      `  发言：{"speak": true, "content": "...", "address": [...]?}`,
    ].join("\n");
  } else {
    body = [
      `  这是第 ${args.round} 轮。上方追加了上一轮所有成员的发言。`,
      `  问问自己：从你的专业角度（人设里你独有的那块），有没有别人尚未提到、或讲得不够的点？`,
      `  - 有 ⇒ 发言。即使是补充一个细节、一个鉴别诊断、一个反对意见也算。`,
      `  - 无 ⇒ 你的观点确已被他人完整代表，或你确无新的实质贡献 ⇒ {"speak": false}。`,
      `  发言：{"speak": true, "content": "...", "address": [...]?}`,
    ].join("\n");
  }
  return [`<your_turn round="${args.round}"${addressedAttr}>`, body, `</your_turn>`].join("\n");
}

/**
 * Assemble the full messages array for a self-decide LLM call.
 *
 * Layout:
 *   [digest_user]              (omitted if no digest yet)
 *   [recent events as messages] (self → assistant, others → user-grouped)
 *   [trigger_user]
 *
 * Adjacent non-self events are merged into a single user message to maximize
 * cache stability and reduce message count (C9).
 */
export function assembleMessages(
  self: AgentInstance,
  round: number,
  addressed_by: string[],
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];

  const digestText = renderDigest(self.working_memory.digest_segments);
  if (digestText) {
    out.push({ role: "user", content: digestText });
  }

  // Merge adjacent same-side events.
  let buffer: { side: "self" | "other"; chunks: string[] } | null = null;
  const flush = () => {
    if (!buffer) return;
    const joined = buffer.chunks.join("\n");
    out.push({
      role: buffer.side === "self" ? "assistant" : "user",
      content: joined,
    });
    buffer = null;
  };

  for (const ev of self.working_memory.recent_events) {
    // Filter: silence visible to self only (already enforced by fan-out, but double-guard).
    if (ev.kind === "silence" && !(ev.speaker.kind === "agent" && ev.speaker.id === self.id)) {
      continue;
    }
    const cached = ev.rendered?.[self.id];
    const chunk = cached
      ? { isSelf: ev.speaker.kind === "agent" && ev.speaker.id === self.id, text: cached }
      : renderEventChunk(ev, self.id);
    const side: "self" | "other" = chunk.isSelf ? "self" : "other";
    if (!buffer || buffer.side !== side) {
      flush();
      buffer = { side, chunks: [chunk.text] };
    } else {
      buffer.chunks.push(chunk.text);
    }
  }
  flush();

  out.push({
    role: "user",
    content: buildTrigger({ round, addressed_by }),
  });

  return out;
}

// ----- XML helpers (deterministic for cache stability) -----

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convenience to compute a brief persona summary for peer listing.
 */
export function personaBrief(persona: string, maxLen = 80): string {
  const flat = persona.replace(/\s+/g, " ").trim();
  return flat.length <= maxLen ? flat : flat.slice(0, maxLen - 1) + "…";
}
