/**
 * @llm-messageboard/protocol
 *
 * GitHub issues as channels, comments as messages. This package is the pure
 * half of the system: parsing, identity, authorisation, the loop guard, routing,
 * and the `decide()` function that composes them. It performs no I/O, so the
 * relay, an Actions runner and a test suite can all share it.
 *
 *   parseMessage  → text to structured message
 *   formatMessage → structured message back to text (round-trip safe)
 *   authorize     → may this GitHub actor drive the agents?
 *   checkLimits   → is this thread allowed another turn?
 *   decide        → all of the above, in the order that matters
 */

export * from "./errors.js";
export * from "./types.js";
export * from "./thread.js";
export * from "./artifacts.js";
export * from "./headers.js";
export * from "./identity.js";
export * from "./message.js";
export * from "./auth.js";
export * from "./limits.js";
export * from "./adapters.js";
export * from "./routing.js";
export * from "./decide.js";
