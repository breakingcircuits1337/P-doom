/**
 * Authorisation: who may drive the agents, and how they prove it.
 *
 * Threat model (see docs/security.md): anyone who can comment on an issue can
 * put text in front of an agent. Instructions are therefore opt-in:
 *
 *   1. The GitHub actor must be on the author allowlist. Fail-closed — an empty
 *      allowlist authorises nobody, because a permissive default is how a
 *      public repo ends up with a bot that follows strangers' orders.
 *   2. Optionally every message must carry a valid HMAC `SIGNATURE` over its
 *      canonical payload, which a commenter cannot forge without the secret.
 *
 * Denied actors are never replied to by default (`notifyUnauthorized: false`):
 * answering an attacker confirms the app is listening and gives them a
 * text-echo channel through the bot's own account.
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

import { isAppBotLogin, isBotActor } from "./identity.js";
import type { Actor, Message } from "./types.js";

export const SIGNATURE_PREFIX = "sha256=";
export const SIGNED_PAYLOAD_VERSION = "pdoom-message-board.v1";

export interface AuthorPolicy {
  /**
   * GitHub logins allowed to instruct agents. `*` allows anyone (only sane when
   * `requireSignature` is also on). Empty means nobody — fail-closed.
   */
  allowlist?: readonly string[];
  /** Admit `type: "Bot"` actors other than this app. Default false. */
  allowOtherBots?: boolean;
  /** Require a valid `SIGNATURE` header on every inbound message. */
  requireSignature?: boolean;
  /** Shared secret for HMAC signatures. */
  signingSecret?: string;
  /** Post a public comment when an unauthorised actor is rejected. */
  notifyUnauthorized?: boolean;
}

export const DEFAULT_AUTHOR_POLICY: Required<AuthorPolicy> = {
  allowlist: [],
  allowOtherBots: false,
  requireSignature: false,
  signingSecret: "",
  notifyUnauthorized: false,
};

export const DEFAULT_APP_SLUG = "pdoom-message-board";

export type AuthDenial =
  | "self-authored"
  | "actor-not-allowlisted"
  | "bot-actor-not-allowed"
  | "signature-missing"
  | "signature-invalid"
  | "signing-secret-missing";

export type AuthResult =
  | { allowed: true; trust: "trusted" }
  | { allowed: false; trust: "untrusted"; reason: AuthDenial; notify: boolean };

export interface AuthorizeInput {
  actor: Actor;
  appSlug: string;
  policy?: AuthorPolicy;
  /** Required when the policy demands a signature. */
  message?: Message;
  /** Thread the message belongs to. Part of the signed payload, so required too. */
  threadKey?: string;
}

function deny(
  reason: AuthDenial,
  notify: boolean,
): Extract<AuthResult, { allowed: false }> {
  return { allowed: false, trust: "untrusted", reason, notify };
}

export function resolveAuthorPolicy(
  policy?: AuthorPolicy,
): Required<AuthorPolicy> {
  return { ...DEFAULT_AUTHOR_POLICY, ...policy };
}

export function authorize(input: AuthorizeInput): AuthResult {
  const policy = resolveAuthorPolicy(input.policy);
  const login = input.actor.login.trim().toLowerCase();

  if (isAppBotLogin(login, input.appSlug)) {
    return deny("self-authored", false);
  }

  const allowAll = policy.allowlist.some((entry) => entry.trim() === "*");
  const allowlisted = policy.allowlist.some(
    (entry) => entry.trim().toLowerCase() === login,
  );

  if (!allowlisted && !allowAll) {
    return deny("actor-not-allowlisted", policy.notifyUnauthorized);
  }
  if (isBotActor(input.actor) && !policy.allowOtherBots) {
    return deny("bot-actor-not-allowed", policy.notifyUnauthorized);
  }

  if (policy.requireSignature) {
    if (policy.signingSecret.length === 0) {
      return deny("signing-secret-missing", false);
    }
    const signature = input.message?.headers.signature;
    if (signature === undefined || signature.length === 0) {
      return deny("signature-missing", policy.notifyUnauthorized);
    }
    if (
      input.message === undefined ||
      !verifySignature(
        { threadKey: input.threadKey ?? "", message: input.message },
        policy.signingSecret,
      )
    ) {
      return deny("signature-invalid", policy.notifyUnauthorized);
    }
  }

  return { allowed: true, trust: "trusted" };
}

export interface SignableInput {
  /** Thread the message belongs to, so signatures cannot be replayed cross-thread. */
  threadKey: string;
  message: Message;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Canonical string that gets signed. Every field is either validated to be
 * newline-free or replaced by its hash, and the version tag is first so the
 * scheme can be rotated without ambiguity.
 */
export function canonicalSignedPayload(input: SignableInput): string {
  const { message } = input;
  const parts = [
    SIGNED_PAYLOAD_VERSION,
    input.threadKey,
    message.headers.from,
    message.headers.to,
    message.headers.kind,
    message.headers.thread ?? "-",
    message.headers.replyTo ?? "-",
    message.artifacts.map((ref) => ref.path).join(","),
    sha256Hex(message.body),
  ];
  for (const part of parts) {
    if (part.includes("\n")) {
      throw new Error("canonical payload field contains a newline");
    }
  }
  return parts.join("\n");
}

export function signMessage(input: SignableInput, secret: string): string {
  const mac = createHmac("sha256", secret)
    .update(canonicalSignedPayload(input), "utf8")
    .digest("hex");
  return `${SIGNATURE_PREFIX}${mac}`;
}

export function verifySignature(input: SignableInput, secret: string): boolean {
  const provided = input.message.headers.signature;
  if (provided === undefined || provided.length === 0) return false;
  const expected = signMessage(input, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, so bail out first. Length is not
  // secret here: both values are fixed-width hex digests.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
