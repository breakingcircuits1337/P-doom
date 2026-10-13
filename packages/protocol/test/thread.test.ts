import { describe, expect, it } from "vitest";

import {
  channelId,
  isValidRepoSegment,
  normalizeSlug,
  parseChannelId,
  parseThreadKey,
  threadKey,
  validateChannel,
} from "../src/index.js";
import { CHANNEL } from "./helpers.js";

describe("channel identity", () => {
  it("round-trips a channel id", () => {
    expect(channelId(CHANNEL)).toBe("acme/widgets#42");
    expect(parseChannelId("acme/widgets#42")).toEqual(CHANNEL);
  });

  it("rejects malformed channel ids", () => {
    expect(parseChannelId("acme/widgets")).toBeUndefined();
    expect(parseChannelId("acme/widgets#0")).toBeUndefined();
    expect(parseChannelId("acme/widgets#abc")).toBeUndefined();
  });

  it("validates each component", () => {
    expect(validateChannel(CHANNEL).ok).toBe(true);
    expect(validateChannel({ ...CHANNEL, issue: 0 }).ok).toBe(false);
    expect(validateChannel({ ...CHANNEL, issue: 1.5 }).ok).toBe(false);
    expect(validateChannel({ ...CHANNEL, owner: "has space" }).ok).toBe(false);
    expect(isValidRepoSegment("widgets.js")).toBe(true);
    expect(isValidRepoSegment("")).toBe(false);
  });
});

describe("thread keys", () => {
  it("uses the bare channel id when there is no sub-thread", () => {
    expect(threadKey(CHANNEL)).toBe("acme/widgets#42");
    expect(threadKey(CHANNEL, null)).toBe("acme/widgets#42");
    expect(threadKey(CHANNEL, "")).toBe("acme/widgets#42");
  });

  it("appends a validated slug for a sub-thread", () => {
    expect(threadKey(CHANNEL, "plan")).toBe("acme/widgets#42/plan");
    expect(threadKey(CHANNEL, "Plan")).toBe("acme/widgets#42/plan");
  });

  it("refuses a slug that would break the key", () => {
    expect(() => threadKey(CHANNEL, "a/b")).toThrow();
    expect(() => threadKey(CHANNEL, "-nope")).toThrow();
    expect(normalizeSlug("..")).toBeUndefined();
    expect(normalizeSlug("9lives")).toBe("9lives");
  });

  it("parses both forms", () => {
    expect(parseThreadKey("acme/widgets#42")).toEqual({
      channel: CHANNEL,
      sub: null,
    });
    expect(parseThreadKey("acme/widgets#42/plan")).toEqual({
      channel: CHANNEL,
      sub: "plan",
    });
    expect(parseThreadKey("acme/widgets#42/BAD SLUG")).toBeUndefined();
    expect(parseThreadKey("garbage")).toBeUndefined();
  });
});
