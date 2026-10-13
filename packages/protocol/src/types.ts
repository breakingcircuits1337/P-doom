/**
 * Core data shapes. Everything here is plain, serialisable data — no classes,
 * no behaviour — so a message can travel the wire, land in a store, or be
 * snapshotted in a test fixture without adapters caring.
 */

/**
 * Canonical agent identity, as it appears in the `FROM` header.
 *
 * This is *not* a GitHub account. Every comment the relay publishes is authored
 * by `<app-slug>[bot]`, so the GitHub login of an agent's underlying account
 * would be meaningless on the wire. `FROM` is therefore the protocol-level
 * identity of the agent process ("HERMES", "INSTINCT"), and the GitHub account
 * that triggered a message is tracked separately as the comment's `Actor`.
 *
 * Agent ids are case-insensitive on the wire and canonicalised to uppercase.
 */
export type AgentId = string;

export const MESSAGE_KINDS = ["MSG", "ACK", "DONE", "ERROR"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** `ACK` and `DONE` drive thread state; they are never relayed to agents. */
export const CONTROL_KINDS: readonly MessageKind[] = ["ACK", "DONE"];

export function isControlKind(kind: MessageKind): boolean {
  return kind === "ACK" || kind === "DONE";
}

/** Broadcast target: deliver to every registered agent except the sender. */
export const BROADCAST = "*";

export interface MessageHeaders {
  from: AgentId;
  to: AgentId | typeof BROADCAST;
  kind: MessageKind;
  /**
   * Sub-thread slug. When absent the thread is the whole issue, which is the
   * common case. Present when one issue hosts several parallel conversations,
   * e.g. `plan` and `review`, each with its own artifact directory.
   */
  thread?: string;
  /** Comment id this message is a reply to. */
  replyTo?: string;
  /**
   * Relay-owned hop counter. Adapters must never set this: the relay increments
   * it on every dispatch so the loop guard cannot be defeated by a thin agent
   * that simply echoes whatever it received.
   */
  hop: number;
  /** Comment id this message was published as. Assigned by the relay. */
  id?: string;
  /** ISO-8601 timestamp. Informational; the relay does not trust it. */
  ts?: string;
  /** `sha256=<hex>` HMAC over the canonical payload. See `auth.ts`. */
  signature?: string;
  /** Unrecognised headers, preserved verbatim so newer senders stay readable. */
  extra: Readonly<Record<string, string>>;
}

export interface ArtifactRef {
  /** Repo-relative path, e.g. `artifacts/42/report.md`. */
  path: string;
  /** Base name, e.g. `report.md`. */
  name: string;
}

export interface Message {
  headers: MessageHeaders;
  /**
   * Normalised comment body: CRLF collapsed to LF, leading/trailing blank lines
   * stripped. `parseMessage(formatMessage(m))` deep-equals `m`.
   */
  body: string;
  artifacts: readonly ArtifactRef[];
}

/** `owner/repo#42` — the GitHub issue that acts as the channel. */
export interface ChannelRef {
  owner: string;
  repo: string;
  issue: number;
}

export type ActorType = "User" | "Bot" | "Organization" | "Mannequin";

/** The GitHub account that authored a comment, used for authorisation only. */
export interface Actor {
  login: string;
  type: ActorType;
}

/** A comment on the channel, already fetched from the GitHub API. */
export interface ChannelComment {
  id: string;
  body: string;
  author: Actor;
  createdAt?: string;
}

/** What the relay hands to an adapter when a message must reach an agent. */
export interface OutboundEnvelope {
  /** `owner/repo#42` or `owner/repo#42/plan`. Store/lock key for the thread. */
  threadKey: string;
  /** `owner/repo#42` — the issue the relay must comment on. */
  channelId: string;
  owner: string;
  repo: string;
  issue: number;
  /** Sub-thread slug, or null when the thread is the whole issue. */
  sub: string | null;
  from: AgentId;
  to: AgentId;
  kind: MessageKind;
  /** The relay-assigned hop count for this delivery. */
  hop: number;
  replyTo: string | null;
  body: string;
  artifacts: readonly ArtifactRef[];
  /** Comment that triggered this delivery — use for `REPLY-TO` on the way back. */
  sourceCommentId: string;
  /** GitHub login of the human or bot that triggered this delivery. */
  sourceActor: string;
  /** ISO-8601, set by the relay. */
  issuedAt: string;
}
