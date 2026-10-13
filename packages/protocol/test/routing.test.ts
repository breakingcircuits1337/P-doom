import { describe, expect, it } from "vitest";

import { MemoryAdapterRegistry, resolveRoute } from "../src/index.js";
import { message, registryOf } from "./helpers.js";

describe("resolveRoute", () => {
  it("delivers to a single registered agent", () => {
    const route = resolveRoute({ message: message(), registry: registryOf("HERMES", "INSTINCT") });
    expect(route).toEqual({
      targets: ["INSTINCT"],
      unknown: [],
      broadcast: false,
    });
  });

  it("reports an addressee with no adapter", () => {
    const route = resolveRoute({ message: message({ headers: { to: "GHOST" } }), registry: registryOf("HERMES") });
    expect(route).toEqual({ targets: [], unknown: ["GHOST"], broadcast: false });
  });

  it("resolves case-insensitively", () => {
    const route = resolveRoute({
      message: message({ headers: { to: "instinct" } }),
      registry: registryOf("INSTINCT"),
    });
    expect(route.targets).toEqual(["INSTINCT"]);
  });

  it("broadcasts to everyone except the sender", () => {
    const route = resolveRoute({
      message: message({ headers: { to: "*" } }),
      registry: registryOf("HERMES", "INSTINCT", "ORACLE"),
    });
    expect(route).toEqual({
      targets: ["INSTINCT", "ORACLE"],
      unknown: [],
      broadcast: true,
    });
  });

  it("broadcasts to nobody when the sender is the only agent", () => {
    const route = resolveRoute({
      message: message({ headers: { to: "*" } }),
      registry: registryOf("HERMES"),
    });
    expect(route.targets).toEqual([]);
    expect(route.broadcast).toBe(true);
  });

  it("never routes an agent to itself", () => {
    const route = resolveRoute({
      message: message({ headers: { to: "HERMES" } }),
      registry: registryOf("HERMES"),
    });
    expect(route).toEqual({ targets: [], unknown: [], broadcast: false });
  });
});

describe("MemoryAdapterRegistry", () => {
  it("registers, looks up and removes case-insensitively", () => {
    const registry = new MemoryAdapterRegistry();
    registry.register({
      agent: "hermes",
      transport: "runner",
      async deliver() {
        return { accepted: true };
      },
    });
    expect(registry.has("HERMES")).toBe(true);
    expect(registry.list()).toEqual(["HERMES"]);
    expect(registry.get("hermes")?.transport).toBe("runner");
    expect(registry.unregister("Hermes")).toBe(true);
    expect(registry.has("HERMES")).toBe(false);
  });

  it("refuses a duplicate registration but lets a reconnect upsert", () => {
    const registry = registryOf("HERMES");
    expect(() => registry.register({ agent: "hermes", transport: "runner", async deliver() { return { accepted: true }; } })).toThrow();
    registry.upsert({ agent: "HERMES", transport: "runner", async deliver() { return { accepted: true }; } });
    expect(registry.get("HERMES")?.transport).toBe("runner");
  });
});
