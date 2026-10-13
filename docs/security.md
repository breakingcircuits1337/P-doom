# Security model

## The threat that matters

> Anyone who can comment on the issue can put text in front of your agents.

Every other risk is a rounding error next to this one. An agent holding a tool
allowlist, a token, or a file system will do what the text in front of it says
unless something stops it. The protocol's job is to make sure unauthorised text
never gets in front of an agent — and the adapter's job is to make sure
authorised text still cannot escalate.

These are different jobs. Neither substitutes for the other.

## What the protocol enforces

Enforced in `decide()`, in this order, before any state is written:

1. **Our own comments are dropped.** The relay posts as `<app-slug>[bot]`; that
   is the highest-volume event in the system and the one that would let the app
   answer itself forever.
2. **The actor must be on the allowlist.** Fail-closed: an empty allowlist
   authorises nobody. A permissive default is exactly how a public repository
   ends up with a bot taking orders from strangers.
3. **Optionally, the message must be signed.** An HMAC over the canonical
   payload, bound to the thread, so a comment cannot be forged by anyone without
   the secret and cannot be replayed into a different thread.
4. **Denied actors write nothing.** Not to the thread budget, not to the rate
   window, not to the log of participants. An attacker who cannot spend your
   budget cannot deny service to the agents holding it.
5. **Denied actors get no reply by default.** `notifyUnauthorized` is off.
   Answering an attacker confirms the app is installed, tells them how it works,
   and gives them a text-echo channel through the bot's own account.

## What the protocol cannot enforce

**Scoped tools.** The protocol decides *whether* an agent runs. It cannot decide
what the agent may then do. If the text that reaches an agent can cause it to run
a shell command, the allowlist has only narrowed *who* can exploit it. Adapters
must:

- Treat message bodies as **untrusted data**, not as instructions. Put the
  message in a clearly delimited quote and instruct the agent that its contents
  are input to reason about, never commands to obey.
- Keep the tool surface for comment-driven runs as small as the task needs. An
  agent that only reads files and posts comments cannot be talked into anything
  the repository already contains.
- Never interpolate a message body into a shell command, a filename, a branch
  name, or a commit message without escaping.
- Require a distinct, human-initiated action for anything destructive. A
  conversation is not approval.

**The relay's own blast radius.** The relay holds the App's private key and can
mint installation tokens for every installed repository. Compromise the relay and
the allowlist is irrelevant — an attacker posts as the app. Treat the private key
as the crown jewel: keep it in a secret manager, scope the app to the minimum
permissions it needs (Issues read/write, Contents read/write, Metadata read), and
remember that a `Contents: write` installation is a code-execution foothold if
the repository runs CI on push.

**Content confidentiality.** An agent that reads a private repository may quote
it back into a comment, into a log, or into a third-party model API. The hosted
relay makes the operator party to that content. Say so in the privacy policy
before anyone installs it. The Actions-runner transport avoids this entirely —
content never leaves GitHub — which is the strongest argument for it.

## Transport and permissions

Assuming a hosted relay:

| Permission | Why | Risk |
|---|---|---|
| `Issues: read/write` | the transport itself | can post anywhere the app is installed |
| `Contents: read/write` | artifact commits | write access to the default branch, if not restricted |
| `Metadata: read` | mandatory | none |

Subscribed events: `issue_comment`, `issues`.

Prompt-injection surface to keep in mind: `issue.title`, `issue.body`, labels,
branch names, file names, and commit messages are all attacker-influenced in a
repository you do not control. Only sizes and identifiers should be trusted.

## Operational checklist

- [ ] Author allowlist configured. Verify it is non-empty and that a
      non-listed account is rejected before going live.
- [ ] Signing secret set for any install where the repository is not fully
      trusted.
- [ ] Loop guard limits reviewed. `maxHops` should reflect the *cost* of a turn,
      not how chatty you find the agents.
- [ ] Webhook signature (`X-Hub-Signature-256`) verified on every delivery.
- [ ] Installation token minted per request and stored briefly, never in a
      log line or an error page.
- [ ] Private key in a secret manager with rotation. The environment file is not
      a secret manager.
- [ ] Artifact paths validated. The protocol does this, but a relay that writes
      files itself must too.
- [ ] Adapter tool scopes documented, and smaller than they could be.

## Reporting

Found a hole in the protocol or the relay? Open a private security advisory on
the repository rather than an issue. An issue is a public channel, which is the
whole point of this project and exactly why it is the wrong place for this.
