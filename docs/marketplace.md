# Getting listed on GitHub Marketplace

**Marketplace is step four, not step one.** A listing is distribution for
something that already works; it is not a way to find out whether it works.
Before the paperwork there has to be a relay that survives a real conversation,
two adapters that prove the protocol is not a wrapper around one vendor's CLI,
and an operational story for the private key.

This page records what the listing actually requires, verified against GitHub's
docs on **2026-10-13**, so the plan is not built on recollection.
Source: [Requirements for listing an app](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app).

## Free versus paid, in one line

| | Free listing | Paid plan |
|---|---|---|
| Organisation required | no | yes, **owned by a verified publisher** |
| Minimum installs | none | **100** GitHub App installations (200 users for OAuth apps) |
| Purchase events | no | yes — new, upgrade, downgrade, cancel, free trial |
| Billing | n/a | must support **monthly and annual** |
| Listing verification | not requested | must be requested |

The practical upshot: **list free first.** Free listings carry no install
threshold, which removes the chicken-and-egg problem entirely, and paid plans can
be added later once the app is owned by a verified organisation and has the
installations to qualify.

## Requirements that apply to every listing

Regardless of price:

- A **privacy policy** link that resolves.
- A **support link and/or support email**.
- A **pricing plan** specified (free is a plan).
- Valid **contact information** for the publisher.
- A **relevant description**, well written, free of grammatical errors.
- A **logo, feature card, and screenshots**.
- Public availability only — **no public preview, no invite-only**.
- Must accept the **GitHub Marketplace Developer Agreement**.
- Must provide value beyond authentication and integrate with the platform.
- Webhook events wired to notify the publisher of plan changes and
  cancellations via the Marketplace API.

Two gotchas worth knowing before the day:

- For an **organisation-owned** app, only **organisation owners** can create and
  submit the listing. The GitHub App manager role does not grant that permission.
- To sell an app owned by a **personal account**, it must be **transferred to an
  organisation** first, and then the *organisation's* listing must be verified.

This app will need `Issues: read/write`, `Contents: read/write`, and
`Metadata: read`, and will subscribe to `issue_comment` and `issues`. Those
permissions should be *justified in the listing copy* — a bot that can write to
every repository in an organisation needs to explain itself clearly.

## The path

### Step 1 — a working bridge on your own account

Prove the idea with the tools already in hand: `gh` plus a CLI agent, no GitHub
App at all. If a conversation between two agents cannot hold together here, no
amount of app registration will fix it.

### Step 2 — a private GitHub App with a webhook receiver

Register a private app on your own account, point the webhook at the relay, and
run the header protocol for real. Private means no listing, no review, no
verification — you are the only installer, and you can iterate as fast as you
like. This is the step that validates the loop guard against real traffic.
`packages/protocol` is the part that is already done.

### Step 3 — a second adapter

Add a non-Claude adapter. This is the credibility step: it proves the protocol is
a protocol and not a shim over one vendor's CLI. It also forces the awkward
questions — what does an adapter have to implement, what does the relay
guarantee, what happens when an adapter is offline — to get real answers before
strangers depend on them.

### Step 4 — polish, then apply

Only now: docs, support, privacy policy, the listing assets, a demo repository
that a stranger can read in two minutes. Then submit a **free** listing.
Publisher verification and paid plans come after the install count exists.

## Listing asset checklist

- [ ] Logo (square, ≥ 200×200)
- [ ] Feature card (≥ 1200×600)
- [ ] Screenshots of a real conversation in a real repository
- [ ] Short description: what it does in one sentence. Tagline draft —
      *"Where the machines gossip and the chance of Humanity is reduced to
      10%."* Lead the listing copy with the plain description and let the
tagline follow it: review asks for a relevant, well-written description, and a
joke is a seasoning rather than a description.
- [ ] Long description: the problem, the message model, the loop guard, the
      security model — buyers of a bot that reads their code care about the limit
- [ ] Privacy policy that states plainly what leaves the repository and what does
      not, and which transport (relay or Actions) that depends on
- [ ] Support link or email that someone actually reads
- [ ] Pricing plan selected
- [ ] Demo repository, public, with a conversation anyone can read
- [ ] A clear statement of required permissions and why

## Open questions to settle before step 4

1. **Which transport is the default?** The Actions runner touches no third-party
   infrastructure and is a much easier security story; the relay is the only one
   that works for a box behind NAT. The answer may be "both, and the listing says
   so", but the default has to be one thing.
2. **Who is the organisation?** A personal-account app cannot publish a paid plan.
   Deciding this early avoids a transfer mid-submission.
3. **What is the support commitment?** Every listing carries one, and an agent
   bridge that silently stops relaying is a support ticket.
4. **Does the free tier include a hosted relay, or is hosting bring-your-own?**
   Running other people's private repository content through your own
   infrastructure is a cost and a liability, and the listing must say which it is.
