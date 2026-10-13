/**
 * Parsing and rendering whole messages (header block + body).
 *
 * The round-trip contract the rest of the system is allowed to rely on:
 *
 *     parseMessage(formatMessage(m))      ≡ m
 *     parseMessage(renderMessage(m, ctx)) ≡ m
 *
 * The second holds because the generated artifact footer is delimited by a
 * reserved marker and stripped on the way back in.
 */

import {
  composeCommentBody,
  parseArtifactList,
  stripArtifactFooter,
  type ArtifactRenderContext,
} from "./artifacts.js";
import { fail, issue, ok, type ProtocolIssue, type Result } from "./errors.js";
import {
  ARTIFACTS_HEADER,
  formatHeaders,
  looksLikeProtocolBlock,
  normalizeNewlines,
  splitHeaderBlock,
  toMessageHeaders,
} from "./headers.js";
import type { ArtifactRef, Message } from "./types.js";

/**
 * Normalise a body so serialisation is idempotent: LF line endings, no leading
 * blank lines, no trailing whitespace or blank lines. Internal trailing spaces
 * are preserved, so markdown hard line breaks keep working.
 */
export function normalizeBody(body: string): string {
  return normalizeNewlines(body)
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/[\s]+$/, "");
}

/**
 * Parse a comment body. Returns a `Result` rather than throwing, because the
 * input is untrusted.
 *
 * `not-a-message` is a distinct, expected outcome: a comment that simply is not
 * addressed to the protocol. Callers should ignore it silently instead of
 * logging an error or replying to it.
 */
export function parseMessage(text: string): Result<Message> {
  const normalized = normalizeNewlines(text);
  if (normalized.trim().length === 0) {
    return fail<Message>([issue("empty", "comment body is empty")]);
  }

  const split = splitHeaderBlock(normalized);
  if (split === undefined) {
    return fail<Message>([
      issue("not-a-message", "comment does not start with a header block"),
    ]);
  }
  if (!looksLikeProtocolBlock(split.fields)) {
    return fail<Message>([
      issue(
        "not-a-message",
        "header-like block contains no known protocol header",
      ),
    ]);
  }

  const problems: ProtocolIssue[] = [];
  for (const key of split.duplicates) {
    problems.push(issue("duplicate-field", `header appears twice`, key));
  }

  let artifacts: ArtifactRef[] = [];
  const artifactsRaw = split.fields[ARTIFACTS_HEADER];
  if (artifactsRaw !== undefined && artifactsRaw.length > 0) {
    const parsed = parseArtifactList(artifactsRaw);
    artifacts = parsed.refs;
    problems.push(...parsed.issues);
  }

  const headers = toMessageHeaders(split.fields);
  if (!headers.ok) problems.push(...headers.issues);

  // Any problem at all — duplicate headers, a bad artifact path, an invalid
  // field — makes the whole message unusable. Check `problems`, not just
  // `headers`, or artifact and duplicate diagnostics get silently dropped.
  if (problems.length > 0 || !headers.ok) return fail<Message>(problems);

  return ok<Message>({
    headers: headers.value,
    body: normalizeBody(stripArtifactFooter(split.body)),
    artifacts,
  });
}

/**
 * Serialise a message. Contains no presentation affordances — just headers and
 * body — so it round-trips exactly.
 */
export function formatMessage(message: Message): string {
  const headerText = formatHeaders(message.headers, message.artifacts);
  const body = normalizeBody(message.body);
  return body.length === 0 ? headerText : `${headerText}\n\n${body}`;
}

/**
 * Serialise a message as it should appear when published: the wire form plus a
 * visible footer linking the artifacts. `parseMessage` strips the footer, so
 * this stays round-trip safe.
 */
export function renderMessage(
  message: Message,
  ctx: ArtifactRenderContext,
): string {
  return composeCommentBody(formatMessage(message), message.artifacts, ctx);
}

/** Single-line header summary, for logs. */
export function headerSummary(message: Message): string {
  const { from, to, kind, hop, thread, replyTo } = message.headers;
  const parts = [`${from}->${to}`, kind, `hop=${hop}`];
  if (thread !== undefined) parts.push(`thread=${thread}`);
  if (replyTo !== undefined) parts.push(`reply-to=${replyTo}`);
  if (message.artifacts.length > 0) {
    parts.push(`artifacts=${message.artifacts.length}`);
  }
  return parts.join(" ");
}
