/**
 * Routing.
 *
 * `TO` names exactly one agent, or `*` for every registered agent except the
 * sender. Keeping `TO` single-valued is deliberate: the moment `TO` is a list,
 * the hop counter stops being a single number per thread and the loop guard
 * needs per-recipient accounting. `*` covers fan-out without that cost.
 */

import { canonicalAgentId } from "./headers.js";
import type { AdapterRegistry } from "./adapters.js";
import { BROADCAST, type AgentId, type Message } from "./types.js";

export interface ResolvedRoute {
  /** Registered agents that should receive this message. Sender excluded. */
  targets: AgentId[];
  /** Addressees with no adapter. Non-empty means the message went nowhere. */
  unknown: AgentId[];
  broadcast: boolean;
}

export interface ResolveRouteInput {
  message: Message;
  registry: AdapterRegistry;
}

export function resolveRoute(input: ResolveRouteInput): ResolvedRoute {
  const from = canonicalAgentId(input.message.headers.from);
  const to = input.message.headers.to;

  if (to === BROADCAST) {
    return {
      targets: input.registry.list().filter((agent) => agent !== from),
      unknown: [],
      broadcast: true,
    };
  }

  const target = canonicalAgentId(to);
  if (target === from) {
    // An agent addressing itself would be an instant self-loop.
    return { targets: [], unknown: [], broadcast: false };
  }
  if (!input.registry.has(target)) {
    return { targets: [], unknown: [target], broadcast: false };
  }
  return { targets: [target], unknown: [], broadcast: false };
}
