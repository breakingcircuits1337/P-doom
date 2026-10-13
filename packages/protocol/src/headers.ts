/**
 * Header block: parsing a `KEY: value` block off the top of a comment, and
 * serialising one back out.
 *
 *     FROM: HERMES
 *     TO: INSTINCT
 *     REPLY-TO: 1234567890
 *
 * Rules that matter:
 *  - The block must be the first thing in the comment and ends at the first
 *    blank line, so the body stays free-form markdown.
 *  - Keys are case- and separator-insensitive (`reply_to` == `Reply-To` ==
 *    `REPLY-TO`) and canonicalise to uppercase. Agent ids canonicalise to
 *    uppercase too, so `FROM: hermes` and `FROM: HERMES` are the same identity.
 *  - Unknown keys are preserved in `extra` so a newer sender's headers survive
 *    a round trip through an older relay instead of being silently dropped.
 *  - A block containing none of the known headers is *not* a protocol message.
 *    That distinction is what stops a normal comment like `Note: ship it` from
 *    being reported as a malformed message forever.
 */

import {
  fail,
  issue,
  ok,
  ProtocolError,
  type ProtocolIssue,
  type Result,
} from "./errors.js";
import { MESSAGE_KINDS, type MessageKind, type MessageHeaders } from "./types.js";

export const ARTIFACTS_HEADER = "ARTIFACTS";
export const MAX_HEADER_VALUE = 512;
export const MAX_HOP = 1000;

/** Canonical serialisation order. Extras follow, sorted, at the end. */
export const HEADER_ORDER = [
  "FROM",
  "TO",
  "KIND",
  "THREAD",
  "REPLY-TO",
  ARTIFACTS_HEADER,
  "HOP",
  "ID",
  "TS",
  "SIGNATURE",
] as const;

export const KNOWN_HEADERS: readonly string[] = HEADER_ORDER;

const HEADER_LINE = /^([A-Za-z][A-Za-z0-9_-]{0,31}):[ \t]*(.*?)[ \t]*$/;
const HEADER_KEY = /^[A-Z][A-Z0-9-]{0,31}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGITS = /^\d{1,32}$/;
const HOP_VALUE = /^\d{1,4}$/;
const SIGNATURE_VALUE = /^sha256=[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function normalizeNewlines(text: string): string {
  return stripBom(text).replace(/\r\n?/g, "\n");
}

export function canonicalHeaderKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/_/g, "-");
}

export function isValidHeaderKey(key: string): boolean {
  return HEADER_KEY.test(key);
}

export function isHeaderLine(line: string): boolean {
  return HEADER_LINE.test(line);
}

export function matchHeaderLine(
  line: string,
): { key: string; value: string } | undefined {
  const match = HEADER_LINE.exec(line);
  if (!match) return undefined;
  return { key: canonicalHeaderKey(match[1] ?? ""), value: (match[2] ?? "").trim() };
}

export function canonicalAgentId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidAgentId(raw: string): boolean {
  return AGENT_ID.test(raw.trim());
}

export interface HeaderBlockSplit {
  /** Canonical key → raw value. First occurrence wins. */
  fields: Record<string, string>;
  /** Keys in the order they appeared. */
  order: string[];
  duplicates: string[];
  /** Everything after the block, with leading blank lines removed. */
  body: string;
}

/**
 * Split a comment into its leading header block and the remaining body.
 * Returns `undefined` when the first line is not a header, which means the
 * comment is not addressed to the protocol at all.
 */
export function splitHeaderBlock(text: string): HeaderBlockSplit | undefined {
  const lines = normalizeNewlines(text).split("\n");
  const first = lines[0];
  if (first === undefined || !isHeaderLine(first)) return undefined;

  const fields: Record<string, string> = {};
  const order: string[] = [];
  const duplicates: string[] = [];
  let consumed = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      consumed = i + 1;
      break;
    }
    const matched = matchHeaderLine(line);
    if (!matched) {
      // Not a header and not blank: the block ended without a separator.
      consumed = i;
      break;
    }
    if (Object.prototype.hasOwnProperty.call(fields, matched.key)) {
      duplicates.push(matched.key);
    } else {
      fields[matched.key] = matched.value;
      order.push(matched.key);
    }
    consumed = i + 1;
  }

  const body = lines.slice(consumed).join("\n").replace(/^(?:[ \t]*\n)+/, "");
  return { fields, order, duplicates, body };
}

/**
 * True when the block contains at least one header we understand. Used to tell
 * "not our message" apart from "our message, written wrong".
 */
export function looksLikeProtocolBlock(fields: Record<string, string>): boolean {
  return KNOWN_HEADERS.some((key) => fields[key] !== undefined);
}

function checkValue(key: string, value: string): ProtocolIssue | undefined {
  if (value.length > MAX_HEADER_VALUE) {
    return issue(
      "value-too-long",
      `value exceeds ${MAX_HEADER_VALUE} characters`,
      key,
    );
  }
  if (CONTROL_CHARS.test(value)) {
    return issue("control-characters", "value contains control characters", key);
  }
  return undefined;
}

/**
 * Validate and coerce a canonicalised field map into typed headers.
 * `ARTIFACTS` is deliberately left out — it is consumed by `parseMessage`.
 */
export function toMessageHeaders(
  fields: Record<string, string>,
): Result<MessageHeaders> {
  const problems: ProtocolIssue[] = [];

  const require = (key: string): string | undefined => {
    const value = fields[key];
    if (value === undefined || value.length === 0) {
      problems.push(issue("missing-field", `missing required ${key} header`, key));
      return undefined;
    }
    const bad = checkValue(key, value);
    if (bad) problems.push(bad);
    return value;
  };

  const fromRaw = require("FROM");
  const toRaw = require("TO");

  let from: string | undefined;
  if (fromRaw !== undefined) {
    from = canonicalAgentId(fromRaw);
    if (!isValidAgentId(from)) {
      problems.push(issue("invalid-field", `invalid agent id "${fromRaw}"`, "FROM"));
      from = undefined;
    }
  }

  let to: string | undefined;
  if (toRaw !== undefined) {
    const trimmed = toRaw.trim();
    if (trimmed === "*") {
      to = "*";
    } else {
      const candidate = canonicalAgentId(trimmed);
      if (!isValidAgentId(candidate)) {
        problems.push(
          issue("invalid-field", `invalid agent id "${toRaw}"`, "TO"),
        );
      } else {
        to = candidate;
      }
    }
  }

  const kindRaw = fields.KIND;
  let kind: MessageKind = "MSG";
  if (kindRaw !== undefined && kindRaw.length !== 0) {
    const bad = checkValue("KIND", kindRaw);
    if (bad) problems.push(bad);
    const candidate = kindRaw.trim().toUpperCase();
    if (!(MESSAGE_KINDS as readonly string[]).includes(candidate)) {
      problems.push(
        issue(
          "unknown-kind",
          `unknown KIND "${kindRaw}" (expected ${MESSAGE_KINDS.join(", ")})`,
          "KIND",
        ),
      );
    } else {
      kind = candidate as MessageKind;
    }
  }

  let thread: string | undefined;
  const threadRaw = fields.THREAD;
  if (threadRaw !== undefined && threadRaw.length !== 0) {
    const bad = checkValue("THREAD", threadRaw);
    if (bad) problems.push(bad);
    const candidate = threadRaw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate)) {
      problems.push(
        issue("invalid-field", `invalid THREAD slug "${threadRaw}"`, "THREAD"),
      );
    } else {
      thread = candidate;
    }
  }

  let replyTo: string | undefined;
  const replyToRaw = fields["REPLY-TO"];
  if (replyToRaw !== undefined && replyToRaw.length !== 0) {
    if (!DIGITS.test(replyToRaw.trim())) {
      problems.push(
        issue(
          "invalid-field",
          `REPLY-TO must be a comment id, got "${replyToRaw}"`,
          "REPLY-TO",
        ),
      );
    } else {
      replyTo = replyToRaw.trim();
    }
  }

  const hopRaw = fields.HOP;
  let hop = 0;
  if (hopRaw !== undefined && hopRaw.length !== 0) {
    const bad = checkValue("HOP", hopRaw);
    if (bad) problems.push(bad);
    const trimmed = hopRaw.trim();
    if (!HOP_VALUE.test(trimmed) || Number.parseInt(trimmed, 10) > MAX_HOP) {
      problems.push(
        issue("invalid-field", `HOP must be 0..${MAX_HOP}, got "${hopRaw}"`, "HOP"),
      );
    } else {
      hop = Number.parseInt(trimmed, 10);
    }
  }

  let id: string | undefined;
  const idRaw = fields.ID;
  if (idRaw !== undefined && idRaw.length !== 0) {
    if (!DIGITS.test(idRaw.trim())) {
      problems.push(
        issue("invalid-field", `ID must be a comment id, got "${idRaw}"`, "ID"),
      );
    } else {
      id = idRaw.trim();
    }
  }

  let ts: string | undefined;
  const tsRaw = fields.TS;
  if (tsRaw !== undefined && tsRaw.length !== 0) {
    const bad = checkValue("TS", tsRaw);
    if (bad) problems.push(bad);
    if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})?$/.test(tsRaw.trim())) {
      problems.push(
        issue("invalid-field", `TS must be ISO-8601, got "${tsRaw}"`, "TS"),
      );
    } else {
      ts = tsRaw.trim();
    }
  }

  let signature: string | undefined;
  const signatureRaw = fields.SIGNATURE;
  if (signatureRaw !== undefined && signatureRaw.length !== 0) {
    if (!SIGNATURE_VALUE.test(signatureRaw.trim())) {
      problems.push(
        issue(
          "invalid-field",
          "SIGNATURE must look like sha256=<64 hex chars>",
          "SIGNATURE",
        ),
      );
    } else {
      signature = signatureRaw.trim();
    }
  }

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (KNOWN_HEADERS.includes(key)) continue;
    const bad = checkValue(key, value);
    if (bad) {
      problems.push(bad);
      continue;
    }
    extra[key] = value;
  }

  if (problems.length > 0 || from === undefined || to === undefined) {
    return fail<MessageHeaders>(problems);
  }

  const headers: MessageHeaders = { from, to, kind, hop, extra };
  if (thread !== undefined) headers.thread = thread;
  if (replyTo !== undefined) headers.replyTo = replyTo;
  if (id !== undefined) headers.id = id;
  if (ts !== undefined) headers.ts = ts;
  if (signature !== undefined) headers.signature = signature;
  return ok(headers);
}

/**
 * Serialise headers. Throws {@link ProtocolError} on violations, because this
 * path only ever handles messages the relay itself built.
 */
export function formatHeaders(
  headers: MessageHeaders,
  artifacts: readonly { path: string }[] = [],
): string {
  const lines: string[] = [];
  // Strict, not sanitising. This is the outbound path we control, so a value
  // that cannot survive a re-parse is a bug worth failing on: silently
  // flattening it would publish a comment our own parser then rejects.
  // `checkValue` rejects newlines and other control characters outright, which
  // is also what makes header injection impossible.
  const push = (key: string, value: string): void => {
    const clean = value.trim();
    const bad = checkValue(key, clean);
    if (bad) throw new ProtocolError(bad);
    lines.push(`${key}: ${clean}`);
  };

  if (!isValidAgentId(headers.from)) {
    throw new ProtocolError(
      issue("invalid-field", `invalid agent id "${headers.from}"`, "FROM"),
    );
  }
  if (headers.to !== "*" && !isValidAgentId(headers.to)) {
    throw new ProtocolError(
      issue("invalid-field", `invalid agent id "${headers.to}"`, "TO"),
    );
  }
  if (!(MESSAGE_KINDS as readonly string[]).includes(headers.kind)) {
    throw new ProtocolError(
      issue("unknown-kind", `unknown KIND "${headers.kind}"`, "KIND"),
    );
  }

  push("FROM", canonicalAgentId(headers.from));
  push("TO", headers.to === "*" ? "*" : canonicalAgentId(headers.to));
  if (headers.kind !== "MSG") push("KIND", headers.kind);
  if (headers.thread !== undefined && headers.thread.length > 0) {
    push("THREAD", headers.thread);
  }
  if (headers.replyTo !== undefined && headers.replyTo.length > 0) {
    push("REPLY-TO", headers.replyTo);
  }
  if (artifacts.length > 0) {
    push(ARTIFACTS_HEADER, artifacts.map((ref) => ref.path).join(", "));
  }
  if (headers.hop > 0) push("HOP", String(headers.hop));
  if (headers.id !== undefined && headers.id.length > 0) push("ID", headers.id);
  if (headers.ts !== undefined && headers.ts.length > 0) push("TS", headers.ts);
  if (headers.signature !== undefined && headers.signature.length > 0) {
    push("SIGNATURE", headers.signature);
  }

  for (const key of Object.keys(headers.extra).sort()) {
    const canonical = canonicalHeaderKey(key);
    if (!isValidHeaderKey(canonical)) {
      throw new ProtocolError(
        issue("invalid-header-key", `invalid custom header "${key}"`, key),
      );
    }
    if (KNOWN_HEADERS.includes(canonical)) {
      throw new ProtocolError(
        issue(
          "reserved-header",
          `"${canonical}" is a reserved header and cannot be set as an extra`,
          canonical,
        ),
      );
    }
    push(canonical, headers.extra[key] ?? "");
  }

  return lines.join("\n");
}