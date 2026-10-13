/**
 * The loop guard.
 *
 * Two agents will happily talk each other into a bill. Every rule here exists to
 * bound that, and they are enforced on the *relay side* only — an adapter can be
 * a twenty-line script that returns text, and the guard still holds.
 *
 * The load-bearing decision is that `hop` is relay-owned. If the hop counter
 * lived in the message the sender wrote, a thin agent that echoes what it
 * received would reset it to zero on every turn and the counter would be
 * decorative. Instead `ThreadState.hop` is incremented by the relay on each
 * dispatch and copied into the outbound `HOP` header read-only.
 *
 * State transitions are pure reducers (`recordInbound`, `recordRelay`,
 * `markTerminated`) so the loop guard is testable without GitHub, timers, or a
 * running relay.
 */

import { isControlKind, type AgentId, type Message } from "./types.js";

/** Relays with no acknowledgement, or with no progress, end after this long. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export interface LimitPolicy {
  /** Max dispatches in a thread before it is halted. Relay-owned. */
  maxHops: number;
  /** Max inbound comments per thread per window. */
  maxMessagesPerWindow: number;
  /** Max non-control messages in a thread, lifetime. */
  maxConversationMessages: number;
  /** Max messages one agent identity may send in a thread. */
  maxMessagesPerAgent: number;
  /** Max distinct agent identities in a thread. */
  maxAgentsPerThread: number;
  /**
   * Max inbound comments from a single GitHub actor per window. This throttles
   * an over-eager *authorised* actor; unauthorised commenters never reach state
   * at all, so they cannot exhaust a thread's budget.
   */
  maxMessagesPerActorPerWindow: number;
  windowMs: number;
  /** Require an ACK before an agent may send another MSG on the same thread. */
  requireAck: boolean;
  /** Allow a trusted actor to resume a thread that already received DONE. */
  reopenOnTrustedMessage: boolean;
  /** Post a public notice when a terminal limit is breached. */
  notifyOnBreach: boolean;
}

export const DEFAULT_LIMIT_POLICY: LimitPolicy = {
  maxHops: 8,
  maxMessagesPerWindow: 30,
  maxConversationMessages: 40,
  maxMessagesPerAgent: 20,
  maxAgentsPerThread: 6,
  maxMessagesPerActorPerWindow: 20,
  windowMs: DEFAULT_WINDOW_MS,
  requireAck: false,
  reopenOnTrustedMessage: true,
  notifyOnBreach: true,
};

/** Breaching these ends the conversation, so the breach is announced once. */
export const TERMINAL_RULES: readonly LimitRule[] = [
  "hop-limit",
  "thread-cap",
  "agent-message-cap",
  "agent-cap",
];

export type LimitRule =
  | "thread-terminated"
  | "actor-rate"
  | "window-rate"
  | "thread-cap"
  | "agent-message-cap"
  | "agent-cap"
  | "hop-limit"
  | "ack-required";

export type LimitVerdict =
  | { ok: true }
  | { ok: false; rule: LimitRule; detail: string };

export interface ActorWindow {
  windowStart: number;
  windowCount: number;
}

export interface ThreadState {
  threadKey: string;
  /** Relay-owned conversation depth: dispatched messages so far. */
  hop: number;
  windowStart: number;
  windowMessages: number;
  windowConversation: number;
  /** Non-control messages, lifetime. */
  conversationMessages: number;
  senderCounts: Record<AgentId, number>;
  agents: AgentId[];
  /** Agents that were sent a message and still owe an ACK. */
  pendingAck: AgentId[];
  terminated: boolean;
  terminatedBy: AgentId | null;
  /** Set once a terminal breach has been announced, so we announce it once. */
  halted: boolean;
  actors: Record<string, ActorWindow>;
  updatedAt: number;
}

export function resolveLimitPolicy(
  overrides?: Partial<LimitPolicy>,
): LimitPolicy {
  return { ...DEFAULT_LIMIT_POLICY, ...overrides };
}

export function createThreadState(threadKey: string, now: number): ThreadState {
  return {
    threadKey,
    hop: 0,
    windowStart: now,
    windowMessages: 0,
    windowConversation: 0,
    conversationMessages: 0,
    senderCounts: {},
    agents: [],
    pendingAck: [],
    terminated: false,
    terminatedBy: null,
    halted: false,
    actors: {},
    updatedAt: now,
  };
}

export function actorKey(login: string): string {
  return login.trim().toLowerCase();
}

/** Expire the thread window and every actor window that has aged out. */
export function rollWindow(
  state: ThreadState,
  now: number,
  policy: LimitPolicy,
): ThreadState {
  const expired = now - state.windowStart >= policy.windowMs;
  const actors: Record<string, ActorWindow> = {};
  let actorsChanged = false;
  for (const [login, entry] of Object.entries(state.actors)) {
    if (now - entry.windowStart >= policy.windowMs) {
      actors[login] = { windowStart: now, windowCount: 0 };
      actorsChanged = true;
    } else {
      actors[login] = entry;
    }
  }
  if (!expired && !actorsChanged) return state;
  return {
    ...state,
    windowStart: expired ? now : state.windowStart,
    windowMessages: expired ? 0 : state.windowMessages,
    windowConversation: expired ? 0 : state.windowConversation,
    actors: actorsChanged ? actors : state.actors,
    updatedAt: now,
  };
}

export interface CheckLimitsInput {
  state: ThreadState;
  message: Message;
  actorLogin: string;
  policy: LimitPolicy;
  now: number;
  /** Whether the triggering actor passed authorisation. Survivors are trusted. */
  trusted: boolean;
}

export function checkLimits(input: CheckLimitsInput): LimitVerdict {
  const { state, message, policy } = input;
  const kind = message.headers.kind;
  const control = isControlKind(kind);
  const from = message.headers.from;

  if (state.terminated && kind !== "DONE") {
    const reopen =
      input.trusted && policy.reopenOnTrustedMessage && kind === "MSG";
    if (!reopen) {
      return {
        ok: false,
        rule: "thread-terminated",
        detail: `thread was closed by ${state.terminatedBy ?? "DONE"}`,
      };
    }
  }

  const actor = state.actors[actorKey(input.actorLogin)];
  if (
    actor !== undefined &&
    input.now - actor.windowStart < policy.windowMs &&
    actor.windowCount >= policy.maxMessagesPerActorPerWindow
  ) {
    return {
      ok: false,
      rule: "actor-rate",
      detail: `${input.actorLogin} sent ${actor.windowCount} messages this window (max ${policy.maxMessagesPerActorPerWindow})`,
    };
  }

  if (state.windowMessages >= policy.maxMessagesPerWindow) {
    return {
      ok: false,
      rule: "window-rate",
      detail: `${state.windowMessages} messages this window (max ${policy.maxMessagesPerWindow})`,
    };
  }

  // Control messages are always allowed to land: a DONE must be able to close a
  // thread that has run out of budget, and an ACK must not be the reason a
  // halted thread can never drain.
  if (!control) {
    if (state.conversationMessages >= policy.maxConversationMessages) {
      return {
        ok: false,
        rule: "thread-cap",
        detail: `thread reached ${state.conversationMessages} messages (max ${policy.maxConversationMessages})`,
      };
    }
    if ((state.senderCounts[from] ?? 0) >= policy.maxMessagesPerAgent) {
      return {
        ok: false,
        rule: "agent-message-cap",
        detail: `${from} sent ${state.senderCounts[from]} messages (max ${policy.maxMessagesPerAgent})`,
      };
    }
    if (!state.agents.includes(from) && state.agents.length >= policy.maxAgentsPerThread) {
      return {
        ok: false,
        rule: "agent-cap",
        detail: `${from} is the ${state.agents.length + 1}th agent (max ${policy.maxAgentsPerThread})`,
      };
    }
    if (state.hop >= policy.maxHops) {
      return {
        ok: false,
        rule: "hop-limit",
        detail: `thread reached hop ${state.hop} (max ${policy.maxHops})`,
      };
    }
    if (policy.requireAck && state.pendingAck.includes(from)) {
      return {
        ok: false,
        rule: "ack-required",
        detail: `${from} has not ACKed the previous message`,
      };
    }
  }

  return { ok: true };
}

export interface RecordInboundInput {
  message: Message;
  actorLogin: string;
  now: number;
}

/**
 * Account for an inbound message that passed every check. Called before routing
 * so that a message to an unknown agent still counts against the thread's
 * budget — otherwise "TO: nobody" would be a free way to spin.
 */
export function recordInbound(
  state: ThreadState,
  input: RecordInboundInput,
): ThreadState {
  const kind = input.message.headers.kind;
  const control = isControlKind(kind);
  const from = input.message.headers.from;
  const login = actorKey(input.actorLogin);
  const actor = state.actors[login] ?? { windowStart: input.now, windowCount: 0 };

  return {
    ...state,
    windowMessages: state.windowMessages + 1,
    windowConversation: control
      ? state.windowConversation
      : state.windowConversation + 1,
    conversationMessages: control
      ? state.conversationMessages
      : state.conversationMessages + 1,
    senderCounts: {
      ...state.senderCounts,
      [from]: (state.senderCounts[from] ?? 0) + 1,
    },
    agents: state.agents.includes(from)
      ? state.agents
      : [...state.agents, from],
    pendingAck:
      kind === "ACK"
        ? state.pendingAck.filter((agent) => agent !== from)
        : state.pendingAck,
    actors: {
      ...state.actors,
      [login]: { windowStart: actor.windowStart, windowCount: actor.windowCount + 1 },
    },
    updatedAt: input.now,
  };
}

export interface RecordRelayInput {
  targets: readonly AgentId[];
  now: number;
  requireAck: boolean;
}

/** Advance the hop counter and note who now owes an acknowledgement. */
export function recordRelay(
  state: ThreadState,
  input: RecordRelayInput,
): ThreadState {
  return {
    ...state,
    hop: state.hop + 1,
    pendingAck: input.requireAck
      ? Array.from(new Set([...state.pendingAck, ...input.targets]))
      : state.pendingAck,
    updatedAt: input.now,
  };
}

export function markTerminated(
  state: ThreadState,
  input: { by: AgentId; now: number },
): ThreadState {
  return {
    ...state,
    terminated: true,
    terminatedBy: input.by,
    pendingAck: [],
    updatedAt: input.now,
  };
}

export function clearTermination(state: ThreadState, now: number): ThreadState {
  if (!state.terminated && state.terminatedBy === null) return state;
  return { ...state, terminated: false, terminatedBy: null, updatedAt: now };
}

/** Remember that a terminal breach was announced, so it is announced once. */
export function markHalted(state: ThreadState, now: number): ThreadState {
  return state.halted ? state : { ...state, halted: true, updatedAt: now };
}

export interface ThreadStateStore {
  get(threadKey: string): ThreadState | undefined;
  set(state: ThreadState): void;
  delete(threadKey: string): boolean;
  keys(): string[];
}

/** Process-local store. The relay swaps this for Redis to survive restarts. */
export class MemoryThreadStateStore implements ThreadStateStore {
  private readonly states = new Map<string, ThreadState>();

  get(threadKey: string): ThreadState | undefined {
    return this.states.get(threadKey);
  }

  set(state: ThreadState): void {
    this.states.set(state.threadKey, state);
  }

  delete(threadKey: string): boolean {
    return this.states.delete(threadKey);
  }

  keys(): string[] {
    return [...this.states.keys()];
  }

  size(): number {
    return this.states.size;
  }
}
