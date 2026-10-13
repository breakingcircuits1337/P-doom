/**
 * The adapter contract.
 *
 * This is the seam that makes the hosting model a choice rather than a
 * commitment. Two transports satisfy the same interface:
 *
 *   "outbound" — a client inside the agent's own network holds a WebSocket or
 *                long-poll to the relay and pulls work. This is the only shape
 *                that works for a box behind NAT, which cannot receive a
 *                webhook at all.
 *   "runner"   — GitHub Actions gets a `workflow_dispatch` and the agent runs in
 *                a GH-hosted runner with the user's own API key as a repo secret.
 *                No relay infrastructure, no private content off-platform.
 *
 * Nothing in the protocol or the loop guard cares which one is in play, so the
 * runner transport can be added later as a peer without touching `decide()`.
 */

import { canonicalAgentId } from "./headers.js";
import type { AgentId, OutboundEnvelope } from "./types.js";

export interface DeliveryReceipt {
  accepted: boolean;
  /** Comment id GitHub assigned, when the adapter published on the relay's behalf. */
  commentId?: string;
  /** Agent identity echoed back by the adapter. Informational. */
  agent?: AgentId;
  /** Why delivery failed, when `accepted` is false. */
  error?: string;
}

export type AdapterTransport = "outbound" | "runner";

export interface AgentAdapter {
  /** Protocol identity this adapter answers for. Compared case-insensitively. */
  readonly agent: AgentId;
  readonly transport: AdapterTransport;
  /** Best-effort: an adapter may be registered while momentarily offline. */
  readonly online?: boolean;
  deliver(envelope: OutboundEnvelope): Promise<DeliveryReceipt>;
}

export interface AdapterRegistry {
  has(agent: AgentId): boolean;
  list(): AgentId[];
  get(agent: AgentId): AgentAdapter | undefined;
}

export class MemoryAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): this {
    const key = canonicalAgentId(adapter.agent);
    if (key.length === 0) throw new Error("adapter.agent must not be empty");
    if (this.adapters.has(key)) {
      throw new Error(`adapter already registered for ${key}`);
    }
    this.adapters.set(key, adapter);
    return this;
  }

  /** Register or replace, for reconnects. */
  upsert(adapter: AgentAdapter): this {
    this.adapters.set(canonicalAgentId(adapter.agent), adapter);
    return this;
  }

  unregister(agent: AgentId): boolean {
    return this.adapters.delete(canonicalAgentId(agent));
  }

  has(agent: AgentId): boolean {
    return this.adapters.has(canonicalAgentId(agent));
  }

  list(): AgentId[] {
    return [...this.adapters.keys()];
  }

  get(agent: AgentId): AgentAdapter | undefined {
    return this.adapters.get(canonicalAgentId(agent));
  }
}

export function createRegistry(
  adapters: readonly AgentAdapter[] = [],
): MemoryAdapterRegistry {
  const registry = new MemoryAdapterRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
