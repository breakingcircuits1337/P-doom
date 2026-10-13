import { describe, expect, it } from "vitest";

import {
  ARTIFACTS_HEADER,
  canonicalAgentId,
  canonicalHeaderKey,
  formatHeaders,
  isHeaderLine,
  isValidAgentId,
  looksLikeProtocolBlock,
  matchHeaderLine,
  ProtocolError,
  splitHeaderBlock,
  toMessageHeaders,
  unwrap,
  type MessageHeaders,
} from "../src/index.js";
import { headers } from "./helpers.js";

describe("splitHeaderBlock", () => {
  it("separates the block from the body at the first blank line", () => {
    const split = splitHeaderBlock("FROM: HERMES\nTO: INSTINCT\n\nhello there");
    expect(split?.fields).toEqual({ FROM: "HERMES", TO: "INSTINCT" });
    expect(split?.order).toEqual(["FROM", "TO"]);
    expect(split?.body).toBe("hello there");
  });

  it("treats a trailing non-header line as the body", () => {
    const split = splitHeaderBlock("FROM: HERMES\nTO: INSTINCT\nplain text");
    expect(split?.fields).toEqual({ FROM: "HERMES", TO: "INSTINCT" });
    expect(split?.body).toBe("plain text");
  });

  it("returns undefined when the comment does not open with a header", () => {
    expect(splitHeaderBlock("hello world")).toBeUndefined();
    expect(splitHeaderBlock("")).toBeUndefined();
    expect(splitHeaderBlock("   \nFROM: HERMES")).toBeUndefined();
  });

  it("is insensitive to key case and separators", () => {
    expect(canonicalHeaderKey("reply_to")).toBe("REPLY-TO");
    expect(canonicalHeaderKey("Reply-To")).toBe("REPLY-TO");
    expect(canonicalHeaderKey(" FROM ")).toBe("FROM");
    const split = splitHeaderBlock("reply_to: 77\nfrom: hermes\n\ntext");
    expect(split?.fields["REPLY-TO"]).toBe("77");
    expect(split?.fields.FROM).toBe("hermes");
  });

  it("normalises CRLF and a BOM", () => {
    expect(splitHeaderBlock("FROM: A\r\nTO: B\r\n\r\nbody")?.body).toBe("body");
    expect(splitHeaderBlock("\uFEFFFROM: A\nTO: B\n\nbody")?.fields.FROM).toBe(
      "A",
    );
  });

  it("keeps the first occurrence and reports duplicates", () => {
    const split = splitHeaderBlock("FROM: FIRST\nFROM: SECOND\nTO: B\n\nx");
    expect(split?.fields.FROM).toBe("FIRST");
    expect(split?.duplicates).toEqual(["FROM"]);
  });

  it("recognises header lines and nothing else", () => {
    expect(isHeaderLine("FROM: HERMES")).toBe(true);
    expect(isHeaderLine("HOP:0")).toBe(true);
    expect(isHeaderLine("1BAD: no")).toBe(false);
    expect(isHeaderLine("no colon")).toBe(false);
    expect(matchHeaderLine("  TO :  INSTINCT ")).toBeUndefined();
    expect(matchHeaderLine("TO:   INSTINCT   ")).toEqual({
      key: "TO",
      value: "INSTINCT",
    });
  });

  it("distinguishes our messages from other comments", () => {
    expect(looksLikeProtocolBlock({ FROM: "A" })).toBe(true);
    expect(looksLikeProtocolBlock({ NOTE: "ship it" })).toBe(false);
    expect(looksLikeProtocolBlock({})).toBe(false);
  });
});

describe("toMessageHeaders", () => {
  const parse = (fields: Record<string, string>): MessageHeaders =>
    unwrap(toMessageHeaders(fields));

  it("applies defaults", () => {
    const parsed = parse({ FROM: "hermes", TO: "instinct" });
    expect(parsed.from).toBe("HERMES");
    expect(parsed.to).toBe("INSTINCT");
    expect(parsed.kind).toBe("MSG");
    expect(parsed.hop).toBe(0);
    expect(parsed.extra).toEqual({});
  });

  it("accepts a broadcast target", () => {
    expect(parse({ FROM: "A", TO: "*" }).to).toBe("*");
  });

  it("requires FROM and TO", () => {
    const result = toMessageHeaders({ FROM: "A" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { code: "missing-field", message: "missing required TO header", field: "TO" },
    ]);
  });

  it("rejects malformed values", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ FROM: "A", TO: "B", KIND: "SHOUT" }, "KIND"],
      [{ FROM: "A", TO: "B", HOP: "-1" }, "HOP"],
      [{ FROM: "A", TO: "B", HOP: "99999" }, "HOP"],
      [{ FROM: "A", TO: "B", "REPLY-TO": "abc" }, "REPLY-TO"],
      [{ FROM: "A", TO: "B", THREAD: "Bad Slug" }, "THREAD"],
      [{ FROM: "A", TO: "B", TS: "yesterday" }, "TS"],
      [{ FROM: "A", TO: "B", SIGNATURE: "nope" }, "SIGNATURE"],
      [{ FROM: "not a valid id", TO: "B" }, "FROM"],
    ];
    for (const [fields, expectedField] of cases) {
      const result = toMessageHeaders(fields);
      expect(result.ok, expectedField).toBe(false);
      if (result.ok) continue;
      expect(result.issues.map((i) => i.field)).toContain(expectedField);
    }
  });

  it("lowercases THREAD slugs and keeps artifacts out of extras", () => {
    const parsed = parse({
      FROM: "A",
      TO: "B",
      THREAD: "Plan",
      [ARTIFACTS_HEADER]: "report.md",
      "X-TRACE": "abc",
    });
    expect(parsed.thread).toBe("plan");
    expect(parsed.extra).toEqual({ "X-TRACE": "abc" });
  });

  it("rejects oversized values", () => {
    const result = toMessageHeaders({ FROM: "A", TO: "B", "X-BIG": "x".repeat(513) });
    expect(result.ok).toBe(false);
  });
});

describe("formatHeaders", () => {
  it("omits defaults and writes in canonical order", () => {
    expect(formatHeaders(headers())).toBe("FROM: HERMES\nTO: INSTINCT");
  });

  it("writes non-default values", () => {
    const text = formatHeaders(
      headers({ kind: "DONE", hop: 3, replyTo: "77", thread: "plan" }),
    );
    expect(text).toBe(
      [
        "FROM: HERMES",
        "TO: INSTINCT",
        "KIND: DONE",
        "THREAD: plan",
        "REPLY-TO: 77",
        "HOP: 3",
      ].join("\n"),
    );
  });

  it("writes artifacts and sorted extras", () => {
    const text = formatHeaders(headers({ extra: { "X-B": "2", "X-A": "1" } }), [
      { path: "report.md" },
    ]);
    expect(text).toBe(
      [
        "FROM: HERMES",
        "TO: INSTINCT",
        "ARTIFACTS: report.md",
        "X-A: 1",
        "X-B: 2",
      ].join("\n"),
    );
  });

  it("refuses to let an extra shadow a reserved header", () => {
    expect(() => formatHeaders(headers({ extra: { from: "EVIL" } }))).toThrow(
      ProtocolError,
    );
    expect(() => formatHeaders(headers({ extra: { "not a key": "x" } }))).toThrow(
      ProtocolError,
    );
  });

  it("cannot be used to inject a second header", () => {
    // A newline in any value is rejected outright rather than flattened, so a
    // forged header can never reach the wire and an unparseable comment can
    // never be published.
    expect(() => formatHeaders(headers({ thread: "plan\nTO: EVIL" }))).toThrow(
      ProtocolError,
    );
    expect(() => formatHeaders(headers({ extra: { "X-NOTE": "a\nb" } }))).toThrow(
      ProtocolError,
    );
  });

  it("produces exactly one header per field", () => {
    const text = formatHeaders(headers({ replyTo: "1", hop: 2 }));
    expect(text.split("\n").filter((line) => line.startsWith("TO:"))).toHaveLength(1);
  });

  it("rejects invalid identities", () => {
    expect(() => formatHeaders(headers({ from: "bad id" }))).toThrow(ProtocolError);
    expect(() => formatHeaders(headers({ to: "bad id" }))).toThrow(ProtocolError);
  });

  it("canonicalises agent ids", () => {
    expect(canonicalAgentId(" hermes ")).toBe("HERMES");
    expect(isValidAgentId("HERMES")).toBe(true);
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("a b")).toBe(false);
  });
});
