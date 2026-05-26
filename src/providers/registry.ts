// Provider registry — resolves "provider:model" bindings to concrete provider + model.
// Adapters register themselves; consumers call resolve(binding).

import type { LLMProvider } from "../core/types.ts";
import { DeepSeekProvider } from "./deepseek.ts";

const registry = new Map<string, LLMProvider>();

export function registerProvider(p: LLMProvider) {
  registry.set(p.id, p);
}

export function getProvider(id: string): LLMProvider {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}. Registered: ${[...registry.keys()].join(", ")}`);
  return p;
}

export interface ResolvedBinding {
  provider: LLMProvider;
  model: string;
}

export function resolveBinding(binding: string): ResolvedBinding {
  // Format: "provider:model"
  const idx = binding.indexOf(":");
  if (idx === -1) throw new Error(`Invalid provider binding: "${binding}" (expected "provider:model")`);
  const provId = binding.slice(0, idx);
  const model = binding.slice(idx + 1);
  return { provider: getProvider(provId), model };
}

export function bootstrapProviders() {
  registerProvider(new DeepSeekProvider());
}
