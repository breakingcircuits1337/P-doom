import { describe, expect, it } from "vitest";

import {
  FOOTER_MARKER,
  formatMessage,
  headerSummary,
  normalizeBody,
  parseMessage,
  renderMessage,
  unwrap,
  type Message,
} from "../src/index.js";
import { CHANNEL, message } from "./helpers.js";

function roundTrip(m: Message): Message {
  return unwrap(parseMessage(formatMessage(m)));
}

describe("round trip", () => {
  const cases: Array<[string, Message]> = [
    ["minimal", message()],
    [
      "reply with sub-thread",
      message({
        headers: { replyTo: "77", thread: "plan", hop: 4, ts: "2026-01-01T00:00:00Z" },
        body: "here is the plan",
      }),
    ],
    ["ack", message({ headers: { kind: "ACK", replyTo: "12" }, body: "" })],
    ["done", message({ headers: { kind: "DONE" }, body: "closing out" })],
    ["error", message({ headers: { kind: "ERROR" }, body: "upstream 500" })],
    [
      "artifacts",
      message({
        artifacts: [
          { path: "report.md", name: "report.md" },
          { path: "logs/run.txt", name: "run.txt" },
        ],
      }),
    ],
    ["extra headers", message({ headers: { extra: { "X-TRACE": "abc-123" } } })],
    [
      "multi-paragraph body",
      message({ body: "para one\n\n- a\n- b\n\npara two" }),
    ],
    [
      "markdown hard break",
      message({ body: "line one  \nline two" }),
    ],
    ["broadcast", message({ headers: { to: "*" } })],
  ];

  for (const [name, m] of cases) {
    it(`preserves ${name}`, () => {
      expect(roundTrip(m)).toEqual(m);
    });

    it(`renders and re-parses ${name}`, () => {
      const rendered = renderMessage(m, { channel: CHANNEL, sub: m.headers.thread, ref: "main" });
      expect(unwrap(parseMessage(rendered))).toEqual(m);
    });
  }

  it("is idempotent under repeated formatting", () => {
    const once = formatMessage(message({ body: "\n\n  spaced  \n\n" }));
    expect(formatMessage(unwrap(parseMessage(once)))).toBe(once);
  });
});

describe("normalizeBody", () => {
  it("trims edge blank lines but keeps internal whitespace", () => {
    expect(normalizeBody("\n\nhello\n\n")).toBe("hello");
    expect(normalizeBody("a\n\nb")).toBe("a\n\nb");
    expect(normalizeBody("hard  \nbreak")).toBe("hard  \nbreak");
    expect(normalizeBody("\r\nline\r\n")).toBe("line");
  });
});

describe("artifacts footer", () => {
  it("is visible when rendered and gone after parsing", () => {
    const m = message({ artifacts: [{ path: "report.md", name: "report.md" }] });
    const rendered = renderMessage(m, { channel: CHANNEL, ref: "main" });
    expect(rendered).toContain(FOOTER_MARKER);
    expect(rendered).toContain(
      "https://github.com/acme/widgets/blob/main/artifacts/42/report.md",
    );
    expect(unwrap(parseMessage(rendered)).body).toBe(m.body);
  });

  it("is not emitted when there are no artifacts", () => {
    expect(renderMessage(message(), { channel: CHANNEL })).not.toContain(
      FOOTER_MARKER,
    );
  });
});

describe("rejected input", () => {
  it("calls a plain comment not-a-message", () => {
    for (const body of ["hello world", "Note: ship it", "# a heading", "   "]) {
      const result = parseMessage(body);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues[0]?.code).toBe(
        body.trim() === "" ? "empty" : "not-a-message",
      );
    }
  });

  it("reports a malformed protocol message with its field", () => {
    const result = parseMessage("FROM: HERMES\n\nwhere to?");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { code: "missing-field", message: "missing required TO header", field: "TO" },
    ]);
  });

  it("reports duplicates", () => {
    const result = parseMessage("FROM: A\nFROM: B\nTO: C\n\nx");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("duplicate-field");
  });

  it("reports a bad artifact name", () => {
    const result = parseMessage("FROM: A\nTO: B\nARTIFACTS: ../escape.md\n\nx");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toContain("invalid-artifact-name");
  });
});

describe("headerSummary", () => {
  it("describes a message in one line", () => {
    expect(
      headerSummary(
        message({
          headers: { hop: 2, thread: "plan", replyTo: "9" },
          artifacts: [{ path: "a.md", name: "a.md" }],
        }),
      ),
    ).toBe("HERMES->INSTINCT MSG hop=2 thread=plan reply-to=9 artifacts=1");
  });
});
