import { describe, expect, it } from "vitest";

import {
  artifactDir,
  artifactPath,
  blobUrl,
  composeCommentBody,
  FOOTER_MARKER,
  formatArtifactList,
  MAX_ARTIFACTS,
  parseArtifactList,
  refFromPath,
  renderArtifactFooter,
  stripArtifactFooter,
  validateArtifactName,
} from "../src/index.js";
import { CHANNEL } from "./helpers.js";

describe("artifactName validation", () => {
  it("accepts ordinary relative paths", () => {
    for (const name of ["report.md", "logs/run.txt", "a-b_c.d/e.md", "9.md"]) {
      expect(validateArtifactName(name), name).toBeUndefined();
    }
  });

  it("rejects anything that escapes or hides", () => {
    const bad = [
      "",
      "../escape.md",
      "a/../../b.md",
      "/etc/passwd",
      "\\windows\\path",
      "a//b.md",
      "./a.md",
      ".env",
      "nested/.hidden",
      "dir/",
      "x".repeat(241),
      "a/b/c/d/e/f/g/h/i.md",
      "bad\u0000name.md",
    ];
    for (const name of bad) {
      expect(validateArtifactName(name), name).toBeDefined();
    }
  });
});

describe("artifact paths", () => {
  it("is keyed by issue, then sub-thread", () => {
    expect(artifactDir(CHANNEL)).toBe("artifacts/42");
    expect(artifactDir(CHANNEL, "plan")).toBe("artifacts/42/plan");
    expect(artifactPath(CHANNEL, null, "report.md")).toBe(
      "artifacts/42/report.md",
    );
    expect(artifactPath(CHANNEL, "plan", "logs/run.txt")).toBe(
      "artifacts/42/plan/logs/run.txt",
    );
  });

  it("refuses to build a path from a bad name", () => {
    expect(() => artifactPath(CHANNEL, null, "../escape.md")).toThrow();
  });

  it("derives the display name from the path", () => {
    expect(refFromPath("artifacts/42/logs/run.txt")).toEqual({
      path: "artifacts/42/logs/run.txt",
      name: "run.txt",
    });
  });
});

describe("artifact lists", () => {
  it("parses, trims, and de-duplicates", () => {
    const { refs, issues } = parseArtifactList("report.md, logs/run.txt , report.md");
    expect(issues).toEqual([]);
    expect(refs).toEqual([
      { path: "report.md", name: "report.md" },
      { path: "logs/run.txt", name: "run.txt" },
    ]);
  });

  it("reports bad entries without losing the good ones", () => {
    const { refs, issues } = parseArtifactList("good.md, ../bad.md");
    expect(refs).toEqual([{ path: "good.md", name: "good.md" }]);
    expect(issues.map((i) => i.code)).toEqual(["invalid-artifact-name"]);
  });

  it("caps the number of artifacts", () => {
    const many = Array.from({ length: MAX_ARTIFACTS + 5 }, (_, i) => `f${i}.md`);
    const { refs, issues } = parseArtifactList(many.join(", "));
    expect(refs).toHaveLength(MAX_ARTIFACTS);
    expect(issues.map((i) => i.code)).toContain("too-many-artifacts");
  });

  it("round-trips through the header form", () => {
    const { refs } = parseArtifactList("a.md, b/c.md");
    expect(formatArtifactList(refs)).toBe("a.md, b/c.md");
  });
});

describe("footer rendering", () => {
  it("renders nothing without artifacts", () => {
    expect(renderArtifactFooter([], { channel: CHANNEL })).toBe("");
    expect(composeCommentBody("body", [], { channel: CHANNEL })).toBe("body");
  });

  it("links to the blob when a ref is known", () => {
    const footer = renderArtifactFooter(
      [{ path: "logs/run.txt", name: "run.txt" }],
      { channel: CHANNEL, sub: "plan", ref: "main" },
    );
    expect(footer).toContain(FOOTER_MARKER);
    expect(footer).toContain(
      "https://github.com/acme/widgets/blob/main/artifacts/42/plan/logs/run.txt",
    );
    expect(footer).toContain("`artifacts/42/plan/`");
  });

  it("falls back to a plain path without a ref", () => {
    const footer = renderArtifactFooter([{ path: "a.md", name: "a.md" }], {
      channel: CHANNEL,
    });
    expect(footer).toContain("`artifacts/42/a.md`");
    expect(footer).not.toContain("http");
  });

  it("supports a custom server for enterprise installs", () => {
    expect(
      blobUrl(
        { channel: CHANNEL, ref: "main", serverUrl: "https://ghe.internal/" },
        "artifacts/42/a.md",
      ),
    ).toBe("https://ghe.internal/acme/widgets/blob/main/artifacts/42/a.md");
    expect(blobUrl({ channel: CHANNEL }, "a.md")).toBeUndefined();
  });

  it("appends below the body and strips back off", () => {
    const refs = [{ path: "a.md", name: "a.md" }];
    const body = composeCommentBody("here you go", refs, { channel: CHANNEL });
    expect(body.startsWith("here you go\n\n" + FOOTER_MARKER)).toBe(true);
    expect(stripArtifactFooter(body)).toBe("here you go");

    const footerOnly = composeCommentBody("", refs, { channel: CHANNEL });
    expect(stripArtifactFooter(footerOnly)).toBe("");
  });

  it("is idempotent when there is no footer", () => {
    expect(stripArtifactFooter("just a body")).toBe("just a body");
  });

  it("strips only the first marker, leaving later text alone is not required", () => {
    // A reserved marker inside an authored body is treated as the footer start.
    expect(stripArtifactFooter(`a\n${FOOTER_MARKER}\nb`)).toBe("a");
  });
});
