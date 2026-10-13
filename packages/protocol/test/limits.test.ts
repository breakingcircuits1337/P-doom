import { describe, expect, it } from "vitest";

import {
  actorKey,
  checkLimits,
  clearTermination,
  createThreadState,
  markHalted,
  markTerminated,
  MemoryThreadStateStore,
  recordInbound,
  recordRelay,
  resolveLimitPolicy,
  rollWindow,
  type LimitPolicy,
  type MessageKind,
  type ThreadState,
} from "../src/index.js";
import { BASE_THREAD, message } from "./helpers.js";

const POLICY = resolveLimitPolicy();
const T0 = 1_000_000;

function stateAt(overrides: Partial<ThreadState> = {}): ThreadState {
  return { ...createThreadState(BASE_THREAD, T0), ...overrides };
}

function check(
  state: ThreadState,
  options: {
    kind?: MessageKind;
    from?: string;
    login?: string;
    now?: number;
    policy?: LimitPolicy;
    trusted?: boolean;
  } = {},
) {
  return checkLimits({
    state,
    message: message({
      headers: { kind: options.kind ?? "MSG", from: options.from ?? "HERMES" },
    }),
    actorLogin: options.login ?? "octocat",
    policy: options.policy ?? POLICY,
    now: options.now ?? T0,
    trusted: options.trusted ?? true,
  });
}

describe("policy defaults", () => {
  it("bounds a thread on every axis", () => {
    expect(POLICY.maxHops).toBeGreaterThan(0);
    expect(POLICY.maxMessagesPerWindow).toBeGreaterThan(0);
    expect(POLICY.maxConversationMessages).toBeGreaterThan(0);
    expect(POLICY.maxMessagesPerAgent).toBeGreaterThan(0);
    expect(POLICY.maxAgentsPerThread).toBeGreaterThan(0);
    expect(POLICY.maxMessagesPerActorPerWindow).toBeGreaterThan(0);
    expect(POLICY.windowMs).toBeGreaterThan(0);
    // Loop guard is on by default; ACK requirement is opt-in.
    expect(POLICY.requireAck).toBe(false);
  });

  it("merges overrides over the defaults", () => {
    expect(resolveLimitPolicy({ maxHops: 2 })).toMatchObject({
      maxHops: 2,
      maxConversationMessages: POLICY.maxConversationMessages,
    });
  });
});

describe("checkLimits", () => {
  it("lets a fresh thread through", () => {
    expect(check(stateAt())).toEqual({ ok: true });
  });

  it("halts at the hop limit", () => {
    expect(check(stateAt({ hop: POLICY.maxHops }))).toEqual({
      ok: false,
      rule: "hop-limit",
      detail: expect.stringContaining("hop"),
    });
  });

  it("caps total conversation length", () => {
    expect(check(stateAt({ conversationMessages: POLICY.maxConversationMessages }))).toMatchObject({
      ok: false,
      rule: "thread-cap",
    });
  });

  it("caps how much one agent may say", () => {
    expect(
      check(stateAt({ senderCounts: { HERMES: POLICY.maxMessagesPerAgent } })),
    ).toMatchObject({ ok: false, rule: "agent-message-cap" });
  });

  it("caps how many agents may join", () => {
    const agents = Array.from({ length: POLICY.maxAgentsPerThread }, (_, i) => `A${i}`);
    expect(check(stateAt({ agents }), { from: "NEWCOMER" })).toMatchObject({
      ok: false,
      rule: "agent-cap",
    });
    // An agent already in the thread is not a new participant.
    expect(check(stateAt({ agents }), { from: "A0" })).toEqual({ ok: true });
  });

  it("caps the thread's window rate", () => {
    expect(check(stateAt({ windowMessages: POLICY.maxMessagesPerWindow }))).toMatchObject({
      ok: false,
      rule: "window-rate",
    });
  });

  it("caps a single actor's window rate", () => {
    const actors = { octocat: { windowStart: T0, windowCount: POLICY.maxMessagesPerActorPerWindow } };
    expect(check(stateAt({ actors }))).toMatchObject({ ok: false, rule: "actor-rate" });
    // The same count from an expired window is fine.
    expect(check(stateAt({ actors }), { now: T0 + POLICY.windowMs })).toEqual({ ok: true });
  });

  it("refuses to reopen a closed thread unless a trusted actor resumes it", () => {
    const closed = stateAt({ terminated: true, terminatedBy: "INSTINCT" });
    expect(check(closed, { trusted: false })).toMatchObject({
      ok: false,
      rule: "thread-terminated",
    });
    expect(check(closed, { trusted: true })).toEqual({ ok: true });
  });

  it("lets control messages land even when the budget is gone", () => {
    const spent = stateAt({
      hop: POLICY.maxHops,
      conversationMessages: POLICY.maxConversationMessages,
      windowMessages: POLICY.maxMessagesPerWindow,
    });
    // window-rate is checked before the control exemption, so nudge it back.
    const roomToSpeak = { ...spent, windowMessages: 0 };
    expect(check(roomToSpeak, { kind: "DONE" })).toEqual({ ok: true });
    expect(check(roomToSpeak, { kind: "ACK" })).toEqual({ ok: true });
    expect(check(roomToSpeak, { kind: "MSG" })).toMatchObject({ ok: false });
  });

  it("enforces the ACK requirement when armed", () => {
    const policy = resolveLimitPolicy({ requireAck: true });
    const owing = stateAt({ pendingAck: ["HERMES"] });
    expect(check(owing, { policy })).toMatchObject({ ok: false, rule: "ack-required" });
    expect(check(owing, { policy, kind: "ACK" })).toEqual({ ok: true });
    expect(check(owing, { policy, from: "OTHER" })).toEqual({ ok: true });
  });
});

describe("state reducers", () => {
  it("accounts for an inbound message", () => {
    const next = recordInbound(stateAt(), { message: message(), actorLogin: "OctoCat", now: T0 + 1 });
    expect(next.windowMessages).toBe(1);
    expect(next.conversationMessages).toBe(1);
    expect(next.senderCounts).toEqual({ HERMES: 1 });
    expect(next.agents).toEqual(["HERMES"]);
    expect(next.actors[actorKey("octocat")]).toEqual({ windowStart: T0 + 1, windowCount: 1 });
  });

  it("does not spend conversation budget on control messages", () => {
    const ack = recordInbound(stateAt(), {
      message: message({ headers: { kind: "ACK" } }),
      actorLogin: "octocat",
      now: T0,
    });
    expect(ack.windowMessages).toBe(1);
    expect(ack.conversationMessages).toBe(0);
    expect(ack.windowConversation).toBe(0);
  });

  it("clears the ACK it was waiting for", () => {
    const next = recordInbound(stateAt({ pendingAck: ["HERMES", "INSTINCT"] }), {
      message: message({ headers: { kind: "ACK", from: "HERMES" } }),
      actorLogin: "octocat",
      now: T0,
    });
    expect(next.pendingAck).toEqual(["INSTINCT"]);
  });

  it("advances the hop and records who owes an ACK", () => {
    const relayed = recordRelay(stateAt(), { targets: ["INSTINCT"], now: T0, requireAck: true });
    expect(relayed.hop).toBe(1);
    expect(relayed.pendingAck).toEqual(["INSTINCT"]);

    const plain = recordRelay(stateAt(), { targets: ["INSTINCT"], now: T0, requireAck: false });
    expect(plain.hop).toBe(1);
    expect(plain.pendingAck).toEqual([]);
  });

  it("closes and reopens a thread", () => {
    const closed = markTerminated(stateAt({ pendingAck: ["X"] }), { by: "INSTINCT", now: T0 });
    expect(closed).toMatchObject({ terminated: true, terminatedBy: "INSTINCT", pendingAck: [] });
    expect(clearTermination(closed, T0 + 1)).toMatchObject({
      terminated: false,
      terminatedBy: null,
    });
    expect(clearTermination(stateAt(), T0)).toEqual(stateAt());
  });

  it("announces a terminal breach only once", () => {
    const once = markHalted(stateAt(), T0);
    expect(once.halted).toBe(true);
    expect(markHalted(once, T0 + 5)).toBe(once);
  });

  it("expires the window and every stale actor window", () => {
    const filled = stateAt({
      windowMessages: 5,
      windowConversation: 3,
      actors: {
        octocat: { windowStart: T0, windowCount: 4 },
        late: { windowStart: T0 + POLICY.windowMs - 1, windowCount: 2 },
      },
    });
    expect(rollWindow(filled, T0 + 10, POLICY)).toBe(filled);

    const rolled = rollWindow(filled, T0 + POLICY.windowMs, POLICY);
    expect(rolled.windowMessages).toBe(0);
    expect(rolled.windowConversation).toBe(0);
    expect(rolled.actors.octocat).toEqual({ windowStart: T0 + POLICY.windowMs, windowCount: 0 });
    expect(rolled.actors.late).toEqual({ windowStart: T0 + POLICY.windowMs - 1, windowCount: 2 });
  });
});

describe("MemoryThreadStateStore", () => {
  it("stores by thread key", () => {
    const store = new MemoryThreadStateStore();
    expect(store.get(BASE_THREAD)).toBeUndefined();
    store.set(createThreadState(BASE_THREAD, T0));
    expect(store.size()).toBe(1);
    expect(store.keys()).toEqual([BASE_THREAD]);
    expect(store.get(BASE_THREAD)?.hop).toBe(0);
    expect(store.delete(BASE_THREAD)).toBe(true);
    expect(store.delete(BASE_THREAD)).toBe(false);
    expect(store.get(BASE_THREAD)).toBeUndefined();
  });
});
