// EventBus — simple in-process publish/subscribe.
// One bus per Conversation (lives inside its runner).
// Subscribers receive every event that passes the visibility filter for them.

import type { Event } from "./types.ts";

export type EventListener = (e: Event) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(e: Event) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        // Defensive: a misbehaving listener must not stop fan-out.
        console.error("[eventbus] listener error:", err);
      }
    }
  }

  size(): number {
    return this.listeners.size;
  }
}
