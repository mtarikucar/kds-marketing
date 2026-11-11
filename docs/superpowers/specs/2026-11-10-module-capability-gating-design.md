# Modules open only when their capabilities are connected

Owner request, 2026-11-10: a module is usable only when the workspace has the capability it needs.
Strategy is the foundation and always stays open. Agreed in conversation; this note records it.

## What the owner decided

- **Strategy** has no requirement: always open.
- **Inbox** needs at least one messaging channel: e-mail (`mailbox`), WhatsApp (`whatsapp_cloud`),
  Instagram DM (`instagram_dm`), Messenger (`messenger`), SMS (`sms_line`) or web chat (`webchat`).
- **Growth studio** needs at least one social account (the `social_account` group).
- **Campaigns (outreach)** needs a sending channel: `mailbox`, `sms_line` or `whatsapp_cloud`.
- **Calls** needs telephony (the `telephony` group: `netgsm_pbx`).
- **People** and **Prospects** need nothing.
- **Custom blueprints** choose their requirements from the capability kinds and groups instead of
  free text.
- A locked module stays in the side navigation with a lock; opening it explains what to connect and
  links to connecting it.
- The lock holds for agents too: HTTP and MCP refuse the module's use cases while it is locked.

## Model (builder's calls, recorded)

- A blueprint's `requirements` stay a list of strings. A string that parses as a **requirement
  expression** gates: one or more capability kind keys or group keys joined by `|` (any one
  satisfies it). Every gating requirement must be satisfied (AND across lines). A string that does
  not parse is a descriptive note and never gates, so stored free-text custom blueprints keep
  working unchanged. Kind keys and group keys share one namespace (verified disjoint).
- A requirement is **satisfied** by a capability of a matching kind whose status is `verified` or
  `unreachable` (once connected, a temporary outage must not lock the module). `declared`
  (never connected) and `retired` do not count.
- Built-in blueprints are rebuilt from code on every read, so their new requirements need no data
  migration.
- `GET /api/workspace/modules` (and `jeeta.modules.list`) answers each module with
  `availability: { ready, missing }`, computed server-side from the same rule the gate uses.

## Server-side lock (step 2)

- `check_gate` gains a third check after workspace status and strategy: the use case's module must
  be ready. Use cases map to modules by prefix: `inbox.*` → inbox, `studio.*` → growth studio,
  `outreach.*` → outreach, `calls.*` → calls (`calls.bridge.*`, device-bridge plumbing, excepted).
- Refusal: `409 CAPABILITY_REQUIRED`, `details: { module, missing }`.
- Never locked, whatever the module state: compliance duties — person erasure, consent and
  suppression (opt-out) records — so legal obligations stay available after a channel is retired.
  Webhooks, inbound processing and scheduled jobs do not pass the gate and are unaffected.

## Steps

1. Requirement model, built-in requirements, `availability` in the module list, panel lock (side
   navigation lock, lock screen with a connect link, inbox wrapped), home calendar skips locked
   modules.
2. Server-side lock in `check_gate` for HTTP and MCP, with the compliance exemptions and tests.
3. Custom-blueprint editor: pick requirements from kinds and groups; legacy free text shown as notes.
