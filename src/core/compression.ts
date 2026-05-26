// Per-agent context compression.
// Triggered when recent_events token estimate exceeds threshold.
// Produces a first-person digest segment, appends it, and trims recent_events.

import type { AgentInstance, NormalizedMessage } from "./types.ts";
import { resolveBinding } from "../providers/registry.ts";
import { renderEventChunk } from "./render.ts";

export function estimateTokens(text: string): number {
  // Rough: 1 token ≈ 4 chars for English, ~1.5 chars for CJK.
  // Use a conservative average.
  return Math.ceil(text.length / 2.5);
}

export function workingMemoryTokens(self: AgentInstance): number {
  let t = estimateTokens(self.working_memory.system_prompt);
  for (const seg of self.working_memory.digest_segments) {
    t += estimateTokens(seg.text);
  }
  for (const e of self.working_memory.recent_events) {
    const cached = e.rendered?.[self.id];
    t += estimateTokens(cached ?? renderEventChunk(e, self.id).text);
  }
  return t;
}

export function shouldCompress(self: AgentInstance, maxContext: number): boolean {
  const ratio = self.definition_snapshot.compression_policy.threshold_ratio;
  return workingMemoryTokens(self) > maxContext * ratio;
}

/**
 * Compress the oldest portion of recent_events into a new digest segment.
 * Keeps the most recent (keep_recent_ratio) events intact.
 *
 * Mutates self.working_memory in place.
 */
export async function compressIfNeeded(self: AgentInstance, maxContext: number): Promise<boolean> {
  if (!shouldCompress(self, maxContext)) return false;

  const events = self.working_memory.recent_events;
  if (events.length < 4) return false; // not enough to compress meaningfully

  const keepRatio = self.definition_snapshot.compression_policy.keep_recent_ratio;
  const keepN = Math.max(2, Math.floor(events.length * keepRatio));
  const toCompress = events.slice(0, events.length - keepN);
  const toKeep = events.slice(events.length - keepN);

  if (toCompress.length === 0) return false;

  const rangeFrom = toCompress[0]!.seq;
  const rangeTo = toCompress[toCompress.length - 1]!.seq;

  // Build a compression prompt
  const flatHistory = toCompress
    .map((e) => {
      const who =
        e.speaker.kind === "agent" && e.speaker.id === self.id
          ? "我"
          : e.speaker.display_name;
      if (e.kind === "silence") return `${who} 选择沉默`;
      return `${who}: ${e.content}`;
    })
    .join("\n");

  const sysPrompt = `你是 ${self.definition_snapshot.display_name}。请以第一人称("我")的视角，把下面这段讨论历史压缩为简短的要点笔记，保留：
1. 我自己说过的关键观点；
2. 谁说了什么核心观点；
3. 谁 @ 过谁；
4. 当前讨论的焦点与未解决问题。

要点要紧凑，使用第一人称，不超过 250 字。仅输出压缩后的纯文本，不要 JSON 或 markdown。`;

  const userPrompt = `<history range="${rangeFrom}-${rangeTo}">\n${flatHistory}\n</history>`;

  const { provider, model } = resolveBinding(self.definition_snapshot.provider_binding);
  const messages: NormalizedMessage[] = [{ role: "user", content: userPrompt }];

  // Use raw provider call with a different response_format expectation.
  // We'll call complete() but parser will treat text as silence; capture raw_text.
  // Since DeepSeek complete() forces JSON, we need a side-channel. Simplest:
  // wrap text in JSON via prompt instruction.

  const wrappedSys =
    sysPrompt +
    `\n\n你的输出必须是 JSON: {"speak": true, "content": "<这里写要点>"}`;

  const resp = await provider.complete(
    {
      system: wrappedSys,
      messages,
      output_schema: {
        name: "compression_output",
        schema: { type: "object", properties: { speak: { type: "boolean" }, content: { type: "string" } } },
      },
      max_output_tokens: 400,
      temperature: 0.3,
    },
    model,
  );

  const summary = (resp.parsed.content ?? "").trim();
  if (!summary) return false;

  self.working_memory.digest_segments.push({
    range_seq_from: rangeFrom,
    range_seq_to: rangeTo,
    text: summary,
    created_at: Date.now(),
  });
  self.working_memory.recent_events = toKeep;
  self.working_memory.state_version += 1;
  self.working_memory.total_tokens_in += resp.usage.input;
  self.working_memory.total_tokens_out += resp.usage.output;
  self.working_memory.cache_read_tokens += resp.usage.cache_read;
  self.working_memory.cache_write_tokens += resp.usage.cache_write;

  return true;
}
