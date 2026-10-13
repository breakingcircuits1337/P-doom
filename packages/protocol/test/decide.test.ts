import { describe, expect, it } from "vitest";

import {
  decide,
  formatMessage,
  MemoryThreadStateStore,
  type AuthorPolicy,
  type ChannelComment,
  type Decision,
  type LimitPolicy,
} from "../src/index.js";
import {
  actor,
  APP_SLUG,
  BASE_THREAD,
  CHANNEL,
  commentFrom,
  message,
  rawComment,
  registryOf,
  SELF_LOGIN,
} from "./helpers.js";

const ALLOW: AuthorPolicy = { allowlist: ["octocat"] };

function harness(
  options: {
    auth?: AuthorPolicy;
    limits?: Partial<LimitPolicy>;
    agents?: string[];
  } = {},
) {
  const registry = registryOf(...(options.agents ?? ["HERMES", "INSTINCT"]));
  const store = new MemoryThreadStateStore();
  let clock = 1_000_000;
  return {
    registry,
    store,
    state: () => store.get(BASE_THREAD),
    run(comment: ChannelComment, now?: number) {
      return decide({
        channel: CHANNEL,
        comment,
        appSlug: APP_SLUG,
        registry,
        store,
        now: now ?? (clock += 1000),
        auth: options.auth ?? ALLOW,
        limits: options.limits,
      });
    },
  };
}

function envelopeOf(decision: Decision, index = 0) {
  if (decision.type !== "relay" && decision.type !== "terminate") {
    throw new Error(`decision is ${decision.type}, expected an envelope carrier`);
  }
  const envelope = decision.envelopes[index];
  if (envelope === undefined) throw new Error(`no envelope at index ${index}`);
  return envelope;
}

describe("noise", () => {
  it("ignores the app's own comments", () => {
    const h = harness();
    const decision = h.run(
      commentFrom(message(), { author: actor(SELF_LOGIN, "Bot") }),
    ).decision;
    expect(decision).toEqual({
      type: "ignore",
      reason: "self-authored",
      detail: `${SELF_LOGIN} is this app`,
    });
    expect(h.store.keys()).toEqual([]);
  });

  it("ignores a comment that is not addressed to the protocol", () => {
    const h = harness();
    expect(h.run(rawComment("just a normal comment")).decision).toMatchObject({
      type: "ignore",
      reason: "not-a-message",
    });
    expect(h.run(rawComment("Note: ship it")).decision).toMatchObject({
      type: "ignore",
      reason: "not-a-message",
    });
  });
});

describe("authorisation", () => {
  it("denies a stranger and records nothing", () => {
    const h = harness({ auth: { allowlist: [] } });
    const decision = h.run(commentFrom(message())).decision;
    expect(decision).toMatchObject({
      type: "deny",
      reason: "actor-not-allowlisted",
      notify: false,
    });
    // Critically: a stranger must not be able to burn the thread's budget.
    expect(h.store.keys()).toEqual([]);
  });

  it("can be told to answer a rejected actor", () => {
    const h = harness({ auth: { allowlist: [], notifyUnauthorized: true } });
    expect(h.run(commentFrom(message())).decision).toMatchObject({ notify: true });
  });

  it("tells a trusted author when their message is malformed", () => {
    const trusted = harness();
    expect(
      trusted.run(rawComment("FROM: HERMES\nTO: INSTINCT\nHOP: nope")).decision,
    ).toMatchObject({ type: "deny", reason: "unparseable", notify: true });

    const stranger = harness({ auth: { allowlist: [] } });
    expect(
      stranger.run(rawComment("FROM: HERMES\nTO: INSTINCT\nHOP: nope")).decision,
    ).toMatchObject({ type: "deny", reason: "unparseable", notify: false });
  });
});

describe("relay", () => {
  it("produces an envelope the adapter can act on", () => {
    const h = harness();
    const result = h.run(
      commentFrom(message({ body: "hello there", headers: { replyTo: "55" } })),
    );
    expect(result.decision.type).toBe("relay");
    expect(envelopeOf(result.decision)).toEqual({
      threadKey: BASE_THREAD,
      channelId: BASE_THREAD,
      owner: "acme",
      repo: "widgets",
      issue: 42,
      sub: null,
      from: "HERMES",
      to: "INSTINCT",
      kind: "MSG",
      hop: 1,
      replyTo: "55",
      body: "hello there",
      artifacts: [],
      sourceCommentId: "1001",
      sourceActor: "octocat",
      issuedAt: new Date(1_001_000).toISOString(),
    });
  });

  it("carries artifacts through", () => {
    const h = harness();
    const result = h.run(
      commentFrom(message({ artifacts: [{ path: "plan.md", name: "plan.md" }] })),
    );
    expect(envelopeOf(result.decision).artifacts).toEqual([
      { path: "plan.md", name: "plan.md" },
    ]);
  });

  it("advances the hop counter on every dispatch", () => {
    const h = harness();
    h.run(commentFrom(message()));
    const second = h.run(
      commentFrom(message({ headers: { from: "INSTINCT", to: "HERMES" } }), {
        id: "1002",
      }),
    );
    expect(envelopeOf(second.decision).hop).toBe(2);
    expect(h.state()?.hop).toBe(2);
  });

  it("keeps agent identity in FROM while the GitHub actor stays the app", () => {
    const h = harness();
    const first = h.run(commentFrom(message(), { author: actor("octocat") }));
    const second = h.run(
      commentFrom(message({ headers: { from: "INSTINCT", to: "HERMES" } }), {
        id: "1002",
        author: actor("octocat"),
      }),
    );
    // Same GitHub account, two different protocol identities.
    expect(envelopeOf(first.decision).sourceActor).toBe("octocat");
    expect(envelopeOf(first.decision).from).toBe("HERMES");
    expect(envelopeOf(second.decision).sourceActor).toBe("octocat");
    expect(envelopeOf(second.decision).from).toBe("INSTINCT");
  });

  it("broadcasts past the sender", () => {
    const h = harness({ agents: ["HERMES", "INSTINCT", "ORACLE"] });
    const result = h.run(commentFrom(message({ headers: { to: "*" } })));
    if (result.decision.type !== "relay") throw new Error("expected relay");
    expect(result.decision.envelopes.map((e) => e.to)).toEqual([
      "INSTINCT",
      "ORACLE",
    ]);
  });

  it("counts a message even when nobody can receive it", () => {
    const h = harness();
    expect(
      h.run(commentFrom(message({ headers: { to: "GHOST" } }))).decision,
    ).toMatchObject({ type: "deny", reason: "unknown-target", notify: false });
    expect(h.state()?.windowMessages).toBe(1);
  });
});

describe("loop guard", () => {
  it("stops a two-agent ping-pong and announces it once", () => {
    const h = harness({ limits: { maxHops: 4 } });
    const decisions: Decision[] = [];
    const hops: number[] = [];

    for (let turn = 0; turn < 6; turn += 1) {
      const from = turn % 2 === 0 ? "HERMES" : "INSTINCT";
      const to = from === "HERMES" ? "INSTINCT" : "HERMES";
      const result = h.run(
        commentFrom(message({ headers: { from, to } }), { id: String(2000 + turn) }),
        2_000_000 + turn,
      );
      decisions.push(result.decision);
      if (result.decision.type === "relay") {
        hops.push(envelopeOf(result.decision).hop);
      }
    }

    expect(hops).toEqual([1, 2, 3, 4]);
    expect(decisions.slice(0, 4).every((d) => d.type === "relay")).toBe(true);
    expect(decisions[4]).toMatchObject({
      type: "deny",
      reason: "hop-limit",
      notify: true,
    });
    // Already halted: do not post the same notice on every subsequent comment.
    expect(decisions[5]).toMatchObject({
      type: "deny",
      reason: "hop-limit",
      notify: false,
    });
    expect(h.state()?.hop).toBe(4);
  });

  it("requires an ACK before the next turn when armed", () => {
    const h = harness({ limits: { requireAck: true } });
    h.run(commentFrom(message()));

    expect(
      h.run(
        commentFrom(message({ headers: { from: "INSTINCT", to: "HERMES" } }), {
          id: "1002",
        }),
      ).decision,
    ).toMatchObject({ type: "deny", reason: "ack-required" });

    const acked = h.run(
      commentFrom(
        message({ headers: { from: "INSTINCT", to: "HERMES", kind: "ACK" } }),
        { id: "1003" },
      ),
    );
    expect(acked.decision).toMatchObject({ type: "ack", from: "INSTINCT" });
    expect(acked.state.pendingAck).toEqual([]);

    expect(
      h.run(
        commentFrom(message({ headers: { from: "INSTINCT", to: "HERMES" } }), {
          id: "1004",
        }),
      ).decision.type,
    ).toBe("relay");
  });

  it("never sends an ACK to an agent", () => {
    const h = harness();
    h.run(commentFrom(message()));
    const acked = h.run(
      commentFrom(
        message({ headers: { from: "INSTINCT", to: "HERMES", kind: "ACK" } }),
        { id: "1002" },
      ),
    );
    expect(acked.decision).toEqual({
      type: "ack",
      from: "INSTINCT",
      replyTo: null,
    });
  });
});

describe("closing a thread", () => {
  it("relays DONE to the counterparty and closes", () => {
    const h = harness();
    h.run(commentFrom(message()));
    const result = h.run(
      commentFrom(
        message({ headers: { from: "INSTINCT", to: "HERMES", kind: "DONE" } }),
        { id: "1002" },
      ),
    );
    expect(result.decision).toMatchObject({ type: "terminate", by: "INSTINCT" });
    // A notice, not a turn: the hop counter does not move.
    expect(envelopeOf(result.decision)).toMatchObject({
      to: "HERMES",
      kind: "DONE",
      hop: 1,
    });
    expect(result.state).toMatchObject({
      terminated: true,
      terminatedBy: "INSTINCT",
    });
  });

  it("refuses further traffic once closed", () => {
    const h = harness({ limits: { reopenOnTrustedMessage: false } });
    h.run(commentFrom(message({ headers: { kind: "DONE" } })));
    expect(h.run(commentFrom(message(), { id: "1002" })).decision).toMatchObject({
      type: "deny",
      reason: "thread-terminated",
    });
    expect(
      h.run(
        commentFrom(message({ headers: { kind: "ACK" } }), { id: "1003" }),
      ).decision,
    ).toMatchObject({ type: "deny", reason: "thread-terminated" });
  });

  it("lets a trusted actor resume a closed thread", () => {
    const h = harness();
    h.run(commentFrom(message({ headers: { kind: "DONE" } })));
    const resumed = h.run(commentFrom(message(), { id: "1002" }));
    expect(resumed.decision.type).toBe("relay");
    expect(resumed.state.terminated).toBe(false);
  });
});

describe("thread scoping", () => {
  it("keeps a sub-thread on its own budget and artifact directory", () => {
    const h = harness();
    const plan = h.run(
      commentFrom(message({ headers: { thread: "plan", replyTo: "7" } })),
    );
    expect(plan.threadKey).toBe(`${BASE_THREAD}/plan`);
    expect(envelopeOf(plan.decision)).toMatchObject({
      threadKey: `${BASE_THREAD}/plan`,
      sub: "plan",
    });

    h.run(commentFrom(message(), { id: "1002" }), 1_002_000);
    expect(h.store.keys().sort()).toEqual([BASE_THREAD, `${BASE_THREAD}/plan`]);
    expect(h.state()?.hop).toBe(1);
  });

  it("serialises a parsed message back to the same text", () => {
    const h = harness();
    const comment = commentFrom(message({ body: "round trip me" }));
    const result = h.run(comment);
    expect(result.message).not.toBeNull();
    expect(formatMessage(result.message!)).toBe(comment.body);
  });
});
