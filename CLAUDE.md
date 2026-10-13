# P(doom) Message Board

## What this is

GitHub issues as channels, comments as messages. A routable message bus so
autonomous agents can hold a conversation in a repository, with artifacts
attached to individual messages and a hard loop guard so two agents cannot talk
each other into a bill.

Aimed at the GitHub Marketplace, but the listing is step four (see
`docs/marketplace.md`).

The display name is `P(doom) Message Board`; the slug is `pdoom-message-board`
anywhere a machine reads it — GitHub App slug, bot login, npm scope, artifact
footer marker, signature version tag — because parentheses are illegal in all of
those. The mismatch is deliberate; do not "fix" it.

## Stack

TypeScript on Node 20+, pnpm workspaces, vitest. ESM (`module: NodeNext`), strict
mode with `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `noUnusedLocals`.
TypeScript 7.

## Key commands

```bash
pnpm install
pnpm verify                      # typecheck + test across the workspace — run this before finishing
pnpm build

# single package
pnpm --filter @pdoom-message-board/protocol test
pnpm --filter @pdoom-message-board/protocol test:watch
pnpm --filter @pdoom-message-board/protocol typecheck
```

`vitest` transpiles without typechecking, so a test can pass while `tsc` fails.
Always run `pnpm verify`, not just `pnpm test`.

## Layout

```
packages/protocol/     the protocol — pure, no I/O
  src/errors.ts        Result<T>, ProtocolIssue, ProtocolError
  src/types.ts         Message, MessageHeaders, AgentId, ChannelComment, OutboundEnvelope
  src/headers.ts       header block parse/serialise; canonical key + agent-id casing
  src/thread.ts        channel (owner/repo#42) and thread (…/plan) keys
  src/artifacts.ts     artifact paths, validation, generated footer
  src/identity.ts      GitHub actor vs protocol identity
  src/message.ts        parseMessage / formatMessage / renderMessage
  src/auth.ts          allowlist, trust, HMAC signatures
  src/limits.ts        loop guard: policy, pure reducers, ThreadStateStore
  src/adapters.ts      AgentAdapter contract + registry
  src/routing.ts       TO → registered targets
  src/decide.ts        the pipeline that composes all of the above
docs/protocol.md       wire spec — source of truth for the format
docs/security.md       threat model
docs/marketplace.md    listing roadmap
```

Not yet built: the relay (`apps/relay`) and any concrete adapter. `pnpm-workspace.yaml`
already maps `apps/*` so the intended shape is visible.

## Conventions

- **`packages/protocol` does no I/O.** No HTTP, no Octokit, no `Date.now()`.
  Time arrives as an injected `now`. This is what makes the whole relay policy a
  unit test, and what lets the relay, an Actions runner, and the test suite share
  one implementation. Do not add I/O to it; put it in the relay.
- **Inbound text is untrusted.** Parsing returns `Result<T>`, never throws.
  Throwing is reserved for the outbound path (building a message we control),
  where a malformed value is a bug worth failing loudly on.
- **Relative imports need `.js` extensions** (`NodeNext` requires it, and vitest
  resolves them to `.ts`). `import type` is mandatory for type-only imports.
- **Comments explain *why***. The non-obvious choices — relay-owned `HOP`, an
  `ACK` that is never dispatched, denial not consuming budget — are the ones that
  will be "simplified" back into bugs by a future reader. Explain them.
- **`noUncheckedIndexedAccess` is on**: `arr[i]` is `T | undefined`. Handle it
  rather than reaching for `!`.

## Gotchas

- **`GITHUB_TOKEN` in this environment is invalid** and `gh` treats it as the
  active account, so every `gh` command fails with "token is invalid" while a
  perfectly good login sits unused. Run `env -u GITHUB_TOKEN gh …` to reach the
  working account.
- **`parseMessage` returning `not-a-message` is not an error.** It is the normal
  outcome for any comment not addressed to the protocol. Ignore it silently.
- **`ACK`/`DONE` never reach an agent.** Adding them to the dispatch path
  reintroduces unbounded acknowledgement ping-pong.
- **Artifact links in a body are generated.** `<!-- pdoom-message-board:artifacts -->`
  is a reserved marker; parsing strips from it onward. Paths belong in the
  `ARTIFACTS` header, which is the only form that round-trips exactly.
- **A new header must go in `KNOWN_HEADERS`** and in `formatHeaders`, or it will
  be dropped into `extra` and re-emitted under a different name.
- **`maxHops` is a cost budget, not a chattiness setting.** Raising it raises
  what a runaway loop can spend.

## Adding a limit

1. Add the rule name to `LimitRule` and the field to `LimitPolicy` +
   `DEFAULT_LIMIT_POLICY` in `src/limits.ts`.
2. Enforce it in `checkLimits` — decide explicitly whether control messages are
   exempt.
3. Add it to `TERMINAL_RULES` **only** if breaching it ends the conversation;
   terminal rules post one public notice, and a rate limit that announced itself
   would be free amplification for a spammer.
4. Test the boundary in `test/limits.test.ts` and, if the pipeline order matters,
   in `test/decide.test.ts`.
