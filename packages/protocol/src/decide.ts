/**
 * `decide()` — the whole relay policy in one pure function.
 *
 * Given a comment, the thread state and the registry, it returns an action. It
 * touches no HTTP, no GitHub API and no clock other than the `now` it is handed,
 * so every behaviour below is a unit test rather than an integration test.
 *
 * Check order is load-bearing, not incidental:
 *
 *   1. our own echo        — highest volume event; must never route
 *   2. parse               — a signature policy needs the parsed message
 *   3. authorise           — before any state is written, so a stranger cannot
 *                            burn the thread's message budget
 *   4. loop guard          — bounded hops, window rate, caps, ACK requirement
 *   5. record + route      — the message now counts, even if it goes nowhere
 *   6. dispatch            — ACK/DONE mutate; MSG/ERROR produces envelopes
 */

import type { AdapterRegistry } from "./adapters.js";
import { authorize, type AuthDenial, type AuthorPolicy } from "./auth.js";
import { describeIssues, type ProtocolIssue } from "./errors.js";
import { isSelfAuthored } from "./identity.js";
import {
  checkLimits,
  clearTermination,
  createThreadState,
  markHalted,
  markTerminated,
  recordInbound,
  recordRelay,
  resolveLimitPolicy,
  rollWindow,
  TERMINAL_RULES,
  type LimitPolicy,
  type LimitRule,
  type ThreadState,
  type ThreadStateStore,
} from "./limits.js";
import { parseMessage } from "./message.js";
import { resolveRoute } from "./routing.js";
import { channelId, threadKey } from "./thread.js";
import type {
  AgentId,
  ChannelComment,
  ChannelRef,
  Message,
  MessageKind,
  OutboundEnvelope,
} from "./types.js";

export type DecisionReason =
  | AuthDenial
  | LimitRule
  | "not-a-message"
  | "unparseable"
  | "unknown-target"
  | "no-targets";

export type Decision =
  /** Not addressed to us, or addressed by us. Do nothing, log nothing. */
  | { type: "ignore"; reason: DecisionReason; detail: string }
  /** Understood and rejected. `notify` says whether to post a public notice. */
  | { type: "deny"; reason: DecisionReason; detail: string; notify: boolean }
  /** Acknowledgement: state only, never dispatched to an agent. */
  | { type: "ack"; from: AgentId; replyTo: string | null }
  /** Forward the message to one or more agents. */
  | { type: "relay"; kind: MessageKind; envelopes: OutboundEnvelope[] }
  /** `DONE` seen: tell the counterparty, then close the thread. */
  | { type: "terminate"; by: AgentId; envelopes: OutboundEnvelope[] };

export interface DecideInput {
  channel: ChannelRef;
  comment: ChannelComment;
  appSlug: string;
  registry: AdapterRegistry;
  store: ThreadStateStore;
  /** Milliseconds since epoch. Injected so tests are deterministic. */
  now: number;
  auth?: AuthorPolicy;
  limits?: Partial<LimitPolicy>;
}

export interface DecisionResult {
  decision: Decision;
  /** Thread the decision applies to. Differs from the channel when `THREAD:` is set. */
  threadKey: string;
  /** Thread state after the decision. Already written to the store. */
  state: ThreadState;
  /** The parsed message, when one was parsed. */
  message: Message | null;
  /** Parser diagnostics, whether or not they were fatal. */
  issues: ProtocolIssue[];
}

function startState(
  store: ThreadStateStore,
  key: string,
  now: number,
  policy: LimitPolicy,
): ThreadState {
  const existing = store.get(key);
  return rollWindow(existing ?? createThreadState(key, now), now, policy);
}

interface BuildEnvelopesInput {
  channel: ChannelRef;
  threadId: string;
  sub: string | null;
  message: Message;
  targets: readonly AgentId[];
  hop: number;
  sourceCommentId: string;
  sourceActor: string;
  now: number;
}

function buildEnvelopes(input: BuildEnvelopesInput): OutboundEnvelope[] {
  const issuedAt = new Date(input.now).toISOString();
  return input.targets.map((target) => ({
    threadKey: input.threadId,
    channelId: channelId(input.channel),
    owner: input.channel.owner,
    repo: input.channel.repo,
    issue: input.channel.issue,
    sub: input.sub,
    from: input.message.headers.from,
    to: target,
    kind: input.message.headers.kind,
    hop: input.hop,
    replyTo: input.message.headers.replyTo ?? null,
    body: input.message.body,
    artifacts: input.message.artifacts,
    sourceCommentId: input.sourceCommentId,
    sourceActor: input.sourceActor,
    issuedAt,
  }));
}

export function decide(input: DecideInput): DecisionResult {
  const policy = resolveLimitPolicy(input.limits);
  const { channel, comment, appSlug, registry, store, now } = input;
  const issues: ProtocolIssue[] = [];

  let threadId = threadKey(channel);
  let state = startState(store, threadId, now, policy);
  let message: Message | null = null;

  const finish = (decision: Decision, persist: boolean): DecisionResult => {
    if (persist) store.set(state);
    return { decision, threadKey: threadId, state, message, issues };
  };

  // 1. Our own comment. The relay posts as `<slug>[bot]`, so this is both the
  //    most common event and the one that would let the app answer itself.
  if (isSelfAuthored(comment.author.login, appSlug)) {
    return finish(
      {
        type: "ignore",
        reason: "self-authored",
        detail: `${comment.author.login} is this app`,
      },
      false,
    );
  }

  // 2. Parse. Pure and cheap; no state is touched yet.
  const parsed = parseMessage(comment.body);
  if (!parsed.ok) {
    issues.push(...parsed.issues);
    const detail = describeIssues(parsed.issues);
    const notAMessage = parsed.issues.every(
      (issueItem) =>
        issueItem.code === "not-a-message" || issueItem.code === "empty",
    );
    if (notAMessage) {
      return finish({ type: "ignore", reason: "not-a-message", detail }, false);
    }
    // Shaped like ours but malformed. Tell a trusted author so they can fix it;
    // stay silent for everyone else, since an error reply is a channel a
    // stranger would otherwise get for free.
    const trusted = authorize({
      actor: comment.author,
      appSlug,
      policy: input.auth,
    });
    return finish(
      { type: "deny", reason: "unparseable", detail, notify: trusted.allowed },
      false,
    );
  }
  message = parsed.value;

  // 3. A sub-thread is its own conversation: separate budget, separate artifact
  //    directory. Resolve the real key before reading or writing state.
  const sub = message.headers.thread ?? null;
  if (sub !== null) {
    const candidate = threadKey(channel, sub);
    if (candidate !== threadId) {
      threadId = candidate;
      state = startState(store, threadId, now, policy);
    }
  }

  // 4. Authorise, before recording anything: a denied actor must not be able to
  //    exhaust the thread's message budget.
  const auth = authorize({
    actor: comment.author,
    appSlug,
    policy: input.auth,
    message,
    threadKey: threadId,
  });
  if (!auth.allowed) {
    return finish(
      {
        type: "deny",
        reason: auth.reason,
        detail: `${comment.author.login} denied (${auth.reason})`,
        notify: auth.notify,
      },
      false,
    );
  }

  // A trusted actor may resume a closed thread.
  if (
    state.terminated &&
    policy.reopenOnTrustedMessage &&
    message.headers.kind === "MSG"
  ) {
    state = clearTermination(state, now);
  }

  // 5. Loop guard.
  const verdict = checkLimits({
    state,
    message,
    actorLogin: comment.author.login,
    policy,
    now,
    trusted: true,
  });
  if (!verdict.ok) {
    const terminal = TERMINAL_RULES.includes(verdict.rule);
    const notify = terminal && policy.notifyOnBreach && !state.halted;
    if (notify) state = markHalted(state, now);
    return finish(
      { type: "deny", reason: verdict.rule, detail: verdict.detail, notify },
      notify,
    );
  }

  // 6. The message counts now, even if routing finds nobody to deliver to —
  //    otherwise "TO: nobody" would be a free way to spin.
  state = recordInbound(state, {
    message,
    actorLogin: comment.author.login,
    now,
  });

  const route = resolveRoute({ message, registry });
  if (route.targets.length === 0) {
    const reason: DecisionReason =
      route.unknown.length > 0 ? "unknown-target" : "no-targets";
    const detail =
      route.unknown.length > 0
        ? `no adapter registered for ${route.unknown.join(", ")}`
        : "no registered agent other than the sender";
    return finish({ type: "deny", reason, detail, notify: false }, true);
  }

  // 7. Dispatch by message kind.
  const kind = message.headers.kind;

  if (kind === "ACK") {
    return finish(
      {
        type: "ack",
        from: message.headers.from,
        replyTo: message.headers.replyTo ?? null,
      },
      true,
    );
  }

  if (kind === "DONE") {
    state = markTerminated(state, { by: message.headers.from, now });
    const envelopes = buildEnvelopes({
      channel,
      threadId,
      sub,
      message,
      targets: route.targets,
      // DONE is a notice, not a turn, so it does not advance the hop counter.
      hop: state.hop,
      sourceCommentId: comment.id,
      sourceActor: comment.author.login,
      now,
    });
    return finish({ type: "terminate", by: message.headers.from, envelopes }, true);
  }

  // The hop counter advances before the envelope is built, so the number the
  // receiving agent sees is the number of dispatches this thread has taken.
  state = recordRelay(state, {
    targets: route.targets,
    now,
    requireAck: policy.requireAck,
  });
  const envelopes = buildEnvelopes({
    channel,
    threadId,
    sub,
    message,
    targets: route.targets,
    hop: state.hop,
    sourceCommentId: comment.id,
    sourceActor: comment.author.login,
    now,
  });
  return finish({ type: "relay", kind, envelopes }, true);
}
