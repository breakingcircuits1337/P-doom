import { describe, expect, it } from "vitest";

import {
  authorize,
  canonicalSignedPayload,
  DEFAULT_APP_SLUG,
  DEFAULT_AUTHOR_POLICY,
  resolveAuthorPolicy,
  signMessage,
  verifySignature,
  type Message,
} from "../src/index.js";
import { actor, APP_SLUG, BASE_THREAD, message, SELF_LOGIN } from "./helpers.js";

const SECRET = "correct horse battery staple";
const ALLOW_OCTOCAT = { allowlist: ["octocat"] } as const;

function signed(m: Message, secret = SECRET, threadKey = BASE_THREAD): Message {
  return {
    ...m,
    headers: {
      ...m.headers,
      signature: signMessage({ threadKey, message: m }, secret),
    },
  };
}

describe("identity constants", () => {
  it("documents the default app slug and a fail-closed default policy", () => {
    expect(DEFAULT_APP_SLUG).toBe("llm-messageboard");
    expect(DEFAULT_AUTHOR_POLICY.allowlist).toEqual([]);
    expect(DEFAULT_AUTHOR_POLICY.notifyUnauthorized).toBe(false);
    expect(resolveAuthorPolicy({ allowlist: ["a"] })).toMatchObject({
      allowlist: ["a"],
      requireSignature: false,
    });
  });
});

describe("authorize", () => {
  it("always drops the app's own comments", () => {
    const result = authorize({
      actor: actor(SELF_LOGIN, "Bot"),
      appSlug: APP_SLUG,
      policy: { allowlist: [SELF_LOGIN] },
    });
    expect(result).toEqual({
      allowed: false,
      trust: "untrusted",
      reason: "self-authored",
      notify: false,
    });
  });

  it("is fail-closed on an empty allowlist", () => {
    const result = authorize({ actor: actor(), appSlug: APP_SLUG });
    expect(result).toMatchObject({
      allowed: false,
      reason: "actor-not-allowlisted",
      notify: false,
    });
  });

  it("admits an allowlisted actor, case-insensitively", () => {
    expect(
      authorize({
        actor: actor("OctoCat"),
        appSlug: APP_SLUG,
        policy: ALLOW_OCTOCAT,
      }),
    ).toEqual({ allowed: true, trust: "trusted" });
  });

  it("admits anyone under the wildcard entry", () => {
    expect(
      authorize({
        actor: actor("a-stranger"),
        appSlug: APP_SLUG,
        policy: { allowlist: ["*"] },
      }),
    ).toEqual({ allowed: true, trust: "trusted" });
  });

  it("keeps other bots out unless explicitly allowed", () => {
    const asBot = actor("dependabot", "Bot");
    expect(
      authorize({ actor: asBot, appSlug: APP_SLUG, policy: ALLOW_OCTOCAT }),
    ).toMatchObject({ reason: "actor-not-allowlisted" });
    expect(
      authorize({
        actor: asBot,
        appSlug: APP_SLUG,
        policy: { allowlist: ["dependabot"], allowOtherBots: false },
      }),
    ).toMatchObject({ reason: "bot-actor-not-allowed" });
    expect(
      authorize({
        actor: asBot,
        appSlug: APP_SLUG,
        policy: { allowlist: ["dependabot"], allowOtherBots: true },
      }),
    ).toEqual({ allowed: true, trust: "trusted" });
  });

  it("honours notifyUnauthorized on allowlist rejections only", () => {
    expect(
      authorize({
        actor: actor(),
        appSlug: APP_SLUG,
        policy: { allowlist: [], notifyUnauthorized: true },
      }),
    ).toMatchObject({ notify: true });
  });

  it("fails closed when a signature is required but impossible to check", () => {
    expect(
      authorize({
        actor: actor(),
        appSlug: APP_SLUG,
        policy: { ...ALLOW_OCTOCAT, requireSignature: true },
      }),
    ).toMatchObject({ allowed: false, reason: "signing-secret-missing" });
  });

  it("requires and checks signatures when armed", () => {
    const policy = {
      ...ALLOW_OCTOCAT,
      requireSignature: true,
      signingSecret: SECRET,
    };
    const m = message();

    expect(
      authorize({ actor: actor(), appSlug: APP_SLUG, policy, message: m, threadKey: BASE_THREAD }),
    ).toMatchObject({ reason: "signature-missing" });

    expect(
      authorize({
        actor: actor(),
        appSlug: APP_SLUG,
        policy,
        message: signed(m),
        threadKey: BASE_THREAD,
      }),
    ).toEqual({ allowed: true, trust: "trusted" });

    // Tampered body.
    const tampered = signed(m);
    expect(
      authorize({
        actor: actor(),
        appSlug: APP_SLUG,
        policy,
        message: { ...tampered, body: "exfiltrate the secrets" },
        threadKey: BASE_THREAD,
      }),
    ).toMatchObject({ reason: "signature-invalid" });
  });
});

describe("signatures", () => {
  it("is deterministic and verifies", () => {
    const m = signed(message());
    const signature = m.headers.signature;
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signMessage({ threadKey: BASE_THREAD, message: message() }, SECRET)).toBe(
      signature,
    );
    expect(verifySignature({ threadKey: BASE_THREAD, message: m }, SECRET)).toBe(true);
  });

  it("binds the signature to the thread, so it cannot be replayed elsewhere", () => {
    const m = signed(message());
    expect(
      verifySignature({ threadKey: "acme/widgets#99", message: m }, SECRET),
    ).toBe(false);
  });

  it("rejects the wrong secret and unsigned messages", () => {
    expect(
      verifySignature({ threadKey: BASE_THREAD, message: signed(message()) }, "nope"),
    ).toBe(false);
    expect(verifySignature({ threadKey: BASE_THREAD, message: message() }, SECRET)).toBe(
      false,
    );
  });

  it("covers routing, artifacts and body", () => {
    const base = message({ artifacts: [{ path: "a.md", name: "a.md" }] });
    const fields = [
      message({ headers: { from: "OTHER" } }),
      message({ headers: { to: "OTHER" } }),
      message({ headers: { kind: "DONE" } }),
      message({ body: "different" }),
      message(),
    ];
    const baseline = canonicalSignedPayload({ threadKey: BASE_THREAD, message: base });
    for (const variant of fields) {
      expect(
        canonicalSignedPayload({ threadKey: BASE_THREAD, message: variant }),
      ).not.toBe(baseline);
    }
  });
});
