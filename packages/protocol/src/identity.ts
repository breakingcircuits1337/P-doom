/**
 * Identity.
 *
 * The single most important thing to internalise about this protocol: every
 * comment the app publishes is authored by the *app*, not by the agent. GitHub
 * attributes it to `<app-slug>[bot]`. So:
 *
 *   GitHub `user.login`  → identifies the *human or bot that typed the comment*.
 *                          Used only for authorisation. Never trusted as an
 *                          agent identity.
 *   `FROM:` header       → identifies the *agent process on the other end of the
 *                          adapter*. Trustworthy only because the relay is the
 *                          sole publisher, and only after `authorize()` ran on
 *                          the actor that triggered it.
 *
 * Conflating those two is the classic bug: an agent that reports its GitHub
 * login as `FROM` will disagree with itself the moment the relay posts on its
 * behalf. `FROM` is protocol identity; `login` is authorisation identity.
 */

import type { Actor, ActorType } from "./types.js";

const ACTOR_TYPES: readonly ActorType[] = [
  "User",
  "Bot",
  "Organization",
  "Mannequin",
];

/** The login GitHub gives the app's bot user, e.g. `hermes-bridge[bot]`. */
export function appBotLogin(appSlug: string): string {
  return `${appSlug}[bot]`;
}

export function isAppBotLogin(login: string, appSlug: string): boolean {
  return login.trim().toLowerCase() === appBotLogin(appSlug).toLowerCase();
}

/** True when a comment was published by this app. Used to drop our own echo. */
export function isSelfAuthored(login: string, appSlug: string): boolean {
  return isAppBotLogin(login, appSlug);
}

export function isBotActor(actor: Actor): boolean {
  return actor.type === "Bot";
}

export function normalizeActor(input: {
  login?: string | null;
  type?: string | null;
}): Actor {
  const login = (input.login ?? "").trim();
  const rawType = (input.type ?? "").trim();
  const type = (ACTOR_TYPES as readonly string[]).includes(rawType)
    ? (rawType as ActorType)
    : "User";
  return { login, type };
}

/** Human-readable `FROM` for logs and rendered notices. */
export function agentDisplay(agent: string): string {
  return agent === "*" ? "everyone" : agent;
}

export const IDENTITY_NOTE =
  "GitHub attributes every relay comment to <app-slug>[bot]; agent identity " +
  "travels in the FROM header, not in the GitHub account.";
