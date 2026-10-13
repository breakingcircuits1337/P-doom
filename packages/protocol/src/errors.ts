/**
 * Error plumbing for the P(doom) Message Board protocol.
 *
 * The protocol never throws for *input it cannot trust* — inbound comment text
 * is untrusted data, so parsing returns a {@link Result} and every failure is a
 * structured {@link ProtocolIssue} the relay can log or surface. Exceptions are
 * reserved for programming errors on the *outbound* path (serialising a message
 * we built ourselves), because a malformed outbound message means a bug in the
 * relay, not a hostile comment.
 */

export type ProtocolErrorCode =
  | "empty"
  | "not-a-message"
  | "missing-field"
  | "invalid-field"
  | "duplicate-field"
  | "value-too-long"
  | "control-characters"
  | "unknown-kind"
  | "invalid-header-key"
  | "reserved-header"
  | "invalid-artifact-name"
  | "too-many-artifacts"
  | "invalid-channel";

export interface ProtocolIssue {
  code: ProtocolErrorCode;
  message: string;
  /** Header name (canonical, uppercase) or field name the issue relates to. */
  field?: string;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly field: string | undefined;

  constructor(protoIssue: ProtocolIssue) {
    super(
      protoIssue.field
        ? `${protoIssue.field}: ${protoIssue.message}`
        : protoIssue.message,
    );
    this.name = "ProtocolError";
    this.code = protoIssue.code;
    this.field = protoIssue.field;
  }
}

export function issue(
  code: ProtocolErrorCode,
  message: string,
  field?: string,
): ProtocolIssue {
  return field === undefined ? { code, message } : { code, message, field };
}

/** One-line summary of a batch of issues, for logs and decision details. */
export function describeIssues(protoIssues: readonly ProtocolIssue[]): string {
  return protoIssues
    .map((i) => (i.field ? `${i.field}: ${i.message}` : i.message))
    .join("; ");
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ProtocolIssue[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(protoIssues: ProtocolIssue[]): Result<T> {
  if (protoIssues.length === 0) {
    throw new ProtocolError(
      issue("invalid-field", "fail() requires at least one issue"),
    );
  }
  return { ok: false, issues: protoIssues };
}

/** Unwrap a successful result, or throw. For outbound paths we control. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const first = result.issues[0];
  throw new ProtocolError(
    first ?? issue("invalid-field", "result failed with no issues"),
  );
}
