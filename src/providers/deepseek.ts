// DeepSeek adapter. DeepSeek exposes an OpenAI-compatible Chat Completions API.
// We use response_format = json_object to enforce structured self-decide output.
//
// Cache hints: DeepSeek supports implicit context caching automatically when the
// request prefix matches (no explicit cache_control needed). So we only need to
// keep the prefix byte-stable; the API will report cache_hit_tokens in usage.

import type {
  LLMProvider,
  NormalizedRequest,
  NormalizedResponse,
  ProviderCapabilities,
  SelfDecideOutput,
} from "../core/types.ts";

export class DeepSeekProvider implements LLMProvider {
  readonly id = "deepseek";

  capabilities(): ProviderCapabilities {
    return {
      supports_cache_hints: true, // implicit
      supports_structured_output: true,
      max_context: 128_000,
    };
  }

  async complete(req: NormalizedRequest, model: string, signal?: AbortSignal): Promise<NormalizedResponse> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey.trim() === "") {
      throw new Error(
        "DEEPSEEK_API_KEY is not set. Export it or write it to .env.",
      );
    }
    const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

    // Compose messages: system first (stable), then provided messages.
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.max_output_tokens,
      temperature: req.temperature ?? 0.7,
      response_format: { type: "json_object" },
      stream: false,
    };
    if (req.stop && req.stop.length > 0) body.stop = req.stop;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DeepSeek API error ${res.status}: ${text}`);
    }

    const data: any = await res.json();
    const choice = data.choices?.[0];
    const rawText: string = choice?.message?.content ?? "";
    const finishReason: string = choice?.finish_reason ?? "stop";

    let parsed: SelfDecideOutput;
    try {
      parsed = parseSelfDecide(rawText);
    } catch (err) {
      // Defensive: treat unparseable as silence with a warning.
      parsed = { speak: false };
    }

    const usage = data.usage ?? {};
    return {
      parsed,
      raw_text: rawText,
      usage: {
        input: usage.prompt_tokens ?? 0,
        output: usage.completion_tokens ?? 0,
        cache_read: usage.prompt_cache_hit_tokens ?? 0,
        cache_write: usage.prompt_cache_miss_tokens ?? 0,
      },
      finish_reason: finishReason,
      model,
    };
  }
}

function parseSelfDecide(text: string): SelfDecideOutput {
  const obj = JSON.parse(text);
  const speak = obj.speak === true;
  if (!speak) return { speak: false };
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  const address = Array.isArray(obj.address) ? obj.address.filter((x: any) => typeof x === "string") : undefined;
  return { speak: true, content, address };
}
