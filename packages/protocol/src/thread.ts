/**
 * Channels and threads.
 *
 * Channel  = a GitHub issue (`owner/repo#42`).
 * Thread   = a channel, or a named sub-thread inside it (`owner/repo#42/plan`).
 *
 * Artifacts hang off the *thread*, so two conversations sharing one issue never
 * collide in the artifact tree.
 */

import { fail, issue, ok, type Result } from "./errors.js";
import type { ChannelRef } from "./types.js";

const REPO_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHANNEL_ID = /^([^/#\s]+)\/([^/#\s]+)#(\d{1,10})$/;
const THREAD_ID = /^([^/#\s]+)\/([^/#\s]+)#(\d{1,10})\/(.+)$/;

export function isValidRepoSegment(segment: string): boolean {
  return REPO_SEGMENT.test(segment);
}

/** Validate a channel triple. Throws nothing — returns issues for the caller. */
export function validateChannel(channel: ChannelRef): Result<ChannelRef> {
  const issues = [];
  if (!isValidRepoSegment(channel.owner)) {
    issues.push(
      issue("invalid-channel", `invalid owner "${channel.owner}"`, "owner"),
    );
  }
  if (!isValidRepoSegment(channel.repo)) {
    issues.push(
      issue("invalid-channel", `invalid repo "${channel.repo}"`, "repo"),
    );
  }
  if (!Number.isInteger(channel.issue) || channel.issue <= 0) {
    issues.push(
      issue("invalid-channel", `invalid issue number "${channel.issue}"`, "issue"),
    );
  }
  return issues.length > 0 ? fail<ChannelRef>(issues) : ok(channel);
}

/** `owner/repo#42`. */
export function channelId(channel: ChannelRef): string {
  return `${channel.owner}/${channel.repo}#${channel.issue}`;
}

export function parseChannelId(text: string): ChannelRef | undefined {
  const match = CHANNEL_ID.exec(text.trim());
  if (!match) return undefined;
  const [, owner, repo, issue] = match;
  const parsed: ChannelRef = {
    owner: owner ?? "",
    repo: repo ?? "",
    issue: Number.parseInt(issue ?? "", 10),
  };
  return validateChannel(parsed).ok ? parsed : undefined;
}

/** Canonicalise a sub-thread slug, lowercasing. `undefined` when invalid. */
export function normalizeSlug(raw: string): string | undefined {
  const slug = raw.trim().toLowerCase();
  return SLUG.test(slug) ? slug : undefined;
}

/**
 * Store/lock key for a conversation. Without a sub-thread this is the channel id
 * itself, so the common case has no extra syntax.
 */
export function threadKey(channel: ChannelRef, sub?: string | null): string {
  if (sub === undefined || sub === null || sub === "") return channelId(channel);
  const slug = normalizeSlug(sub);
  if (slug === undefined) {
    throw new Error(`invalid sub-thread slug: ${JSON.stringify(sub)}`);
  }
  return `${channelId(channel)}/${slug}`;
}

export interface ParsedThreadKey {
  channel: ChannelRef;
  sub: string | null;
}

export function parseThreadKey(text: string): ParsedThreadKey | undefined {
  const trimmed = text.trim();
  const withSub = THREAD_ID.exec(trimmed);
  if (withSub) {
    const [, owner, repo, issue, rest] = withSub;
    const channel: ChannelRef = {
      owner: owner ?? "",
      repo: repo ?? "",
      issue: Number.parseInt(issue ?? "", 10),
    };
    if (!validateChannel(channel).ok) return undefined;
    const sub = normalizeSlug(rest ?? "");
    return sub === undefined ? undefined : { channel, sub };
  }
  const channel = parseChannelId(trimmed);
  return channel === undefined ? undefined : { channel, sub: null };
}

export function isSameThread(a: string, b: string): boolean {
  return a === b;
}
