# Jeeta MCP Connector

Jeeta exposes a curated set of workspace tools over the [Model Context
Protocol](https://modelcontextprotocol.io) (Streamable HTTP transport), so an
external agent — e.g. Claude with the `claude mcp` CLI — can read workspace
data (leads, conversations, campaigns, ad performance, bookings, products,
invoices, reviews, …) and, with a human in the loop by default, take actions
(reply to a customer, launch a campaign, publish a social post, move ad budget,
text an invoice, book an appointment).

**The catalogue is 114 tools across 21 domains, of which 45 are advertised up
front.** The other 67 are reachable through `jeeta.find_tools` and
`jeeta.call_tool` — see
[Tool catalogue](#tool-catalogue).

This guide is for the person setting the connector up for a workspace, not
for the engineer who built it.

## Status — read this before you start

- **The end-to-end path has been run live** (2026-07-29), against the app on a
  real Postgres with a real `mk_live_…` key: auth challenges, scope-filtered
  `tools/list`, all 18 tools of the then-catalogue invoked, a gated call
  queuing without a side
  effect, a human approving **and** applying it for real, a re-apply refused,
  a failed apply reverting instead of stranding, `AUTONOMOUS` running inline,
  a `REP` refused on the write-mode routes, cross-tenant invisibility, the
  migration round trip, and a handshake from the actual
  `@modelcontextprotocol/client` SDK. Two defects were found that way and
  fixed — see the git history for `mcp-approval-executor` and
  `mcp-tool-registry`. What has **not** been exercised is a live provider
  send: the test workspace used a WEBCHAT channel, so no message left the
  system to a real phone or inbox. The catalogue has since grown from 18 tools
  to 114 across five waves (Faz 5 D1–D5) and the work after them; the waves are covered by unit and
  isolation specs, not by a repeat of that live run.
- **Which clients can connect.** Two auth paths now exist, and the endpoint
  takes either on the same route:
  - a static `Authorization: Bearer mk_live_…` header — any client that lets
    you set one, e.g. Claude Code (`claude mcp add --header`). This document
    covers that path.
  - **OAuth 2.1** (Faz 3), which is what claude.ai's and Claude Desktop's
    **custom connector** UI expects — user-bound, PKCE, consent screen. See
    [mcp-oauth-connector.md](./mcp-oauth-connector.md).
- **The write surface is live.** A gated tool call that gets approved and then
  applied genuinely sends the message / changes the campaign / publishes the
  post / moves the budget — there is no dry-run mode. Read
  [Approval-gated tools](#approval-gated-tools) and
  [Write mode: APPROVAL vs AUTONOMOUS](#write-mode-approval-vs-autonomous)
  before minting a key with write scopes for a production workspace.

## Prerequisites

- A running Jeeta backend (`backend/`), reachable at some base URL — these
  examples use `http://localhost:3000`.
- A workspace, and a marketing user in it with the **OWNER** or **MANAGER**
  role (minting an API key requires `settings.manage`, which REP does not
  have).
- The `claude` CLI, if you're connecting Claude Code specifically.

## 1. Mint a workspace API key

MCP authenticates with the same programmatic API keys the REST API already
uses (`backend/src/modules/marketing/services/api-keys.service.ts`) — there is
no separate MCP credential type.

**Via the app:** Settings → API Keys (`/settings/api-keys`). Name the key,
then pick scopes in the create dialog (`CreateApiKeyDialog.tsx`): the two
legacy **Read**/**Write** shorthand checkboxes, plus a **Granular scopes**
section listing the live permission catalog (`GET /api/marketing/roles/catalog`
→ `roles/permissions.ts`) as individual checkboxes — the same list a custom
role is built from. Create it and copy the secret — it is shown **exactly
once**; only its SHA-256 hash is stored server-side (`ApiKeysService.create`),
so if you lose it you have to revoke and mint a new one.

**Via the API**, with a valid OWNER/MANAGER marketing session token:

```bash
curl -sX POST http://localhost:3000/api/marketing/api-keys \
  -H "Authorization: Bearer <your marketing session JWT>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Claude MCP connector", "scopes": ["read", "write"]}'
```

Response includes `"key": "mk_live_…"` once. This is the bearer token the MCP
client uses — a different credential from the session JWT above.

`scopes` accepts the legacy `"read"`/`"write"` shorthands **and** any granular
permission string from `PERMISSIONS` (`roles/permissions.ts` — e.g.
`"settings.manage"`, `"campaigns.write"`, `"contacts.write"`), enforced by
`CreateApiKeyDto`'s `@IsIn(['read', 'write', ...PERMISSIONS])`. See
[Scopes](#scopes) for exactly what the shorthands expand to and why most of
the write-risk tools need a granular scope minted explicitly.

## 2. Connect a client

```bash
# Production
claude mcp add --transport http jeeta https://jeetagrowth.com/api/mcp \
  --header "Authorization: Bearer mk_live_XXXXXXXXXXXXXXXXXXXXXXXX"

# Local development
claude mcp add --transport http jeeta http://localhost:3000/api/mcp \
  --header "Authorization: Bearer mk_live_XXXXXXXXXXXXXXXXXXXXXXXX"
```

Note the path: **`/api/mcp`**, not `/mcp`. `app.setGlobalPrefix('api')` in
`backend/src/app.config.ts` applies to the `@Controller('mcp')` route in
`backend/src/modules/marketing/mcp/mcp.controller.ts`, so the prefix stacks.

After adding, check two things:

1. **The tool list appears.** Ask Claude what Jeeta tools it has, or run
   whatever your client uses to list a server's tools. You will see the
   **advertised** subset of the [catalogue](#tool-catalogue) whose scopes the
   key covers — at most 45 of the 114, and fewer for a narrow key.
   `McpServerFactoryService.build` filters the registry by the key's granted
   scopes per request, so a narrower key legitimately shows fewer tools, not an
   error. A tool you do not see is not necessarily unavailable: ask the model to
   call `jeeta.find_tools` and search for it (see
   [Progressive disclosure](#progressive-disclosure)).
2. **A matching audit row appears.** Call any read-only tool (e.g.
   `jeeta.get_workspace_info`), then check `agent_runs` and `tool_call_logs`
   for it — see [Audit trail](#audit-trail) for how.

If either of those doesn't happen, something in this document is wrong for
your environment and should be corrected before relying on it.

## Endpoint reference

- **`POST /api/mcp`** — the only route. Streamable HTTP per the MCP spec;
  request/response bodies are JSON-RPC framed by the
  `@modelcontextprotocol/server` SDK (`createMcpHandler`).
- **Auth:** `Authorization: Bearer mk_live_…`. Checked on **every request**
  (`McpTokenVerifierService.verifyAccessToken` calls `ApiKeysService.authenticate`,
  which hits the database each time) — a revoked key stops working
  immediately, there is no token cache to wait out.
  - No header, or a header that isn't `Bearer …` → `401` with
    `{"error": "unauthorized", "error_description": "missing bearer token"}`
    and a bare `WWW-Authenticate: Bearer realm="jeeta-mcp"` challenge.
  - A malformed/unknown/revoked key → `401` with
    `{"error": "invalid_token", ...}` and
    `WWW-Authenticate: Bearer realm="jeeta-mcp", error="invalid_token", ...`.
  - Anything else that goes wrong (DB outage, a bug) is a genuine `500`, on
    purpose — the controller deliberately does not relabel a real failure as
    an auth problem.
- **One key = one workspace.** The MCP session's workspace is whatever
  `ApiKey.workspaceId` the key belongs to; there is no cross-workspace key.
- **Argument size cap:** 32 KB of JSON per tool call
  (`MAX_ARGS_BYTES` in `mcp-broker.service.ts`); larger payloads are refused
  before the handler runs.

## Scopes

MCP does not introduce its own permission vocabulary — it reuses the
dot-style permissions already defined in
`backend/src/modules/marketing/roles/permissions.ts` (`PERMISSIONS`:
`leads.read`, `leads.write`, `leads.manage`, `tasks.read`, `tasks.write`,
`contacts.read`, `contacts.write`, `campaigns.read`, `campaigns.write`,
`campaigns.send`, `reports.read`, `courses.manage`, `automations.manage`,
`users.manage`, `billing.manage`, `settings.manage`) — the same catalog the
human role/permission system uses, not a parallel MCP-only list.

The subset a tool may actually demand is `MCP_ALL_SCOPES`
(`backend/src/modules/marketing/mcp/mcp-scopes.ts`), which is also what the
OAuth authorization server publishes as `scopes_supported` and what the consent
screen offers. `users.manage` and `billing.manage` are deliberately absent: no
tool may ever require them (see [What is never a tool](#what-is-never-a-tool)).
`mcp-oauth-metadata.controller.spec.ts` fails if any tool declares a scope
missing from that list, since such a tool would be unreachable over OAuth.

An API key's `scopes` array can hold **either** the legacy `read`/`write`
shorthands **or** any of those granular permission strings directly, or a mix
of both (`CreateApiKeyDto`'s `@IsIn(['read', 'write', ...PERMISSIONS])`).
`expandScopes()` is what turns a key's raw `scopes` into the granted set an MCP
tool call is checked against, on every request (no caching — see
[Endpoint reference](#endpoint-reference)):

| Raw key scope | Expands to |
|---|---|
| `read` | `leads.read`, `contacts.read`, `campaigns.read`, `reports.read`, `tasks.read` |
| `write` | everything `read` grants, **plus** `leads.write`, `tasks.write` — **nothing else** |
| any granular string (e.g. `settings.manage`, `campaigns.send`, `contacts.write`, `courses.manage`, `automations.manage`) | passed through untouched |

**What the legacy shorthands do and do not buy.** The rule
(`mcp-scopes.ts`, `mcp-scopes.spec.ts`) is that a manager-tier or send-tier
permission is never acquired by a coarse legacy key: `contacts.write`,
`campaigns.write`, `campaigns.send`, `leads.manage`, `courses.manage`,
`automations.manage` and `settings.manage` must all be minted explicitly. Over
REST a coarse `write` key only ever touched leads/tasks, and MCP does not
silently widen that into "can message customers / publish content / spend ad
budget / arm automations".

That said, **a legacy `write` key is no longer equivalent to a `read` key** — a
claim earlier versions of this document made, true when the catalogue was 18
tools and none needed `leads.write`. Faz 5 changed that. A `write` key now
reaches, among others, `jeeta.create_lead`, `jeeta.update_lead`,
`jeeta.set_lead_status`, `jeeta.add_lead_note`, `jeeta.create_task`,
`jeeta.complete_task`, `jeeta.create_opportunity`,
`jeeta.move_opportunity_stage`, `jeeta.create_estimate` — and
**`jeeta.click_to_dial`**, which requires only `leads.write` and places a real
outbound phone call to a lead (approval-gated, but reachable). Treat a `write`
key as a CRM-write credential that can also dial, and prefer granular scopes.

To reach anything else — messaging customers, publishing, spending, automations,
invoicing, courses, reviews — mint a key (or add scopes to an existing one)
carrying the specific granular permission, via the Settings UI's **Granular
scopes** checklist or by passing the string in the API's `scopes` array (e.g.
`{"scopes": ["read", "settings.manage"]}`).

## Tool catalogue

**114 tools in 21 domains, 45 of them advertised and 67 deferred.** They are registered in
`backend/src/modules/marketing/mcp/tools/*.tools.ts`, wired in
`marketing.module.ts`, and asserted by name and count in
`backend/src/modules/marketing/mcp/tools/tool-catalogue.spec.ts` — a dropped
registration fails CI rather than silently shrinking the surface.

**Argument names are exact, and the two call paths differ.** Every tool's
schema is registered strict (`McpToolRegistry.register`). Over the MCP
transport (`tools/call`) the SDK validates against that strict schema, so an
argument the tool does not declare is an error — `Unrecognized key: "query"`.
Through `jeeta.call_tool` the broker deliberately does NOT reject it: callers
have always been able to pass extra fields and handlers ignore what they do not
need, so refusing them would break calls that work today. It is no longer
silent about it — the response carries `ignoredArgs` and a warning saying the
result is **not** filtered by those fields.

Treat that warning as an error in your own client. This matters most on
optional filters: a dropped one widens the result set, and a search that
answers with everything looks to an agent exactly like a search that matched
everything. Read the parameter names off `tools/list`, which advertises
`additionalProperties: false` for the same reason.

**No tool takes a `workspaceId` argument.** The workspace comes from the
session, never from the caller. Each wave's `dN-isolation.spec.ts` drives every
one of its tools with a foreign workspace id planted in every free-text field
and asserts it reaches no service call.

### Progressive disclosure

Past roughly 60 tools, listing everything at once measurably degrades a model's
accuracy, so `tools/list` returns only the **advertised** subset — every
domain's primary read plus its common writes — and everything else is
**deferred**: still registered, still scope-checked, still callable by name,
just not pushed into every session's context.

`jeeta.find_tools` is the way back to the rest. It takes a free-text `query`
and/or a `domain`, searches name + description + domain over exactly the tools
the caller's scopes already permit, and returns each match with its **JSON input
schema**, so a model can call a tool it has just discovered on the very next
turn. It requires no scopes (it can only reveal what the caller could already
call) and is never itself deferred.

`limit` is capped at 60 while the catalogue is 114, so a broad listing is
paged: the response carries `offset`, and `nextOffset` when there is more.
Pass it back to walk the rest. `nextOffset` is **absent** on the last page
rather than null, so its presence is itself the "there is more" signal.

**`jeeta.find_tools` only finds; `jeeta.call_tool` runs.** A standard MCP
client will not invoke a name it never saw in `tools/list`, so a deferred tool
is reached by calling `jeeta.call_tool` with `{"name": "jeeta.…", "input":
{…}}`. It applies the target tool's own scope, risk and approval rules — it is
a transport, not a bypass — and returns `applied: false` with
`status: "PENDING_APPROVAL"` when the target is gated.

Deferral is an advertising decision, never a permission one. The ceiling on the
advertised set is **45**, pinned in `tool-catalogue.spec.ts`; a wave that wants
more must defer something, not raise the number. D4 paid for itself by deferring
five previously-advertised tools, D5 by deferring two more
(`jeeta.close_conversation`, `jeeta.get_budget`). The catalogue now sits exactly
at the ceiling.

### Risk and approval classes

Every tool declares a `risk` and whether it `requiresApproval`. The vocabulary
(`mcp-tool-registry.ts`) is four values, and what they MEAN is enforced in one
place — `ALWAYS_APPROVED_RISKS` in `mcp-broker.service.ts`:

| Risk | Meaning | In `APPROVAL` mode | In `AUTONOMOUS` mode |
|---|---|---|---|
| `READ` | reads workspace data | runs inline | runs inline |
| `WRITE` | changes workspace data | runs inline unless `requiresApproval` | runs inline |
| `SPEND` | **real money leaves the workspace** (ad budget, fal.ai generation, AI credits + live scraping) | **queued** | **queued — autonomy cannot bypass it** |
| `DESTRUCTIVE` | **a row is permanently removed**; there is no undo table | **queued** | **queued — autonomy cannot bypass it** |

`SPEND` and `DESTRUCTIVE` are gated in **every** write mode. This is a
risk-CLASS rule, not a per-tool flag, so a tool author cannot forget it, and
`mcp-broker.destructive.spec.ts` pins both directions.

The design spec's `SEND` and `PUBLISH` rows are not separate risk values: they
behave exactly like `WRITE` at the gate (risky, but runnable unattended in
`AUTONOMOUS`) and are distinguished for the human reviewing the queue by the
tool's `approvalKind`. The kinds in use are `SEND`, `PUBLISH`,
`BUDGET_REALLOCATION`, `MEDIA_SPEND`, `AI_SPEND`, `TARGET_CHANGE`,
`CHANNEL_LAUNCH`, `STRATEGY_ACTION` and `DESTRUCTIVE`.

**Read this before turning on `AUTONOMOUS`:** 19 tools are approval-gated, but
only the 8 that are `SPEND`/`DESTRUCTIVE` stay gated in autonomous mode. The
other 11 — including `jeeta.send_message`, `jeeta.send_email`,
`jeeta.click_to_dial`, `jeeta.publish_social_post`, `jeeta.schedule_social_post`,
`jeeta.set_campaign_status`, `jeeta.send_invoice`, `jeeta.create_booking` and
`jeeta.reply_to_review` — run immediately, reaching real customers and real
audiences with nobody in the loop. See
[Write mode](#write-mode-approval-vs-autonomous).

### The catalogue

"Listed" = advertised in `tools/list`; the rest need `jeeta.find_tools`.
"Gated" names the `approvalKind` when the tool is approval-gated; **bold** means
`SPEND`/`DESTRUCTIVE`, i.e. gated in every mode including autonomous.

#### Analytics · Brand · Workspace

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.get_funnel` | Lead funnel counts per stage for a date range | `reports.read` | READ | — | yes |
| `jeeta.search_brand_knowledge` | Free-text search over the Brand Brain (tone, positioning, products, policies), cited passages | `reports.read` | READ | — | yes |
| `jeeta.get_brand_profile` | The workspace's brand profile (name, voice guide, audience) | `reports.read` | READ | — | no |
| `jeeta.update_brand_profile` | Rewrite the brand profile every piece of AI copy is written from | `settings.manage` | WRITE | — | no |
| `jeeta.get_workspace_info` | Effective plan: package, subscription status, quotas/limits, enabled features | `reports.read` | READ | — | yes |
| `jeeta.find_tools` | Search the FULL catalogue, deferred tools included, with their input schemas | *(none)* | READ | — | yes |
| `jeeta.get_ai_usage` | Anthropic spend for this workspace: tokens and real cost per action and model, plus a daily curve | `reports.read` | READ | — | no |
| `jeeta.get_vendor_spend` | Outside-vendor spend (NetGSM, Meta, fal.ai, Firecrawl, Apify) and which units have no tariff at all | `reports.read` | READ | — | no |
| `jeeta.list_background_jobs` | This workspace's background jobs with status, attempts and the error from the last attempt | `reports.read` | READ | — | no |
| `jeeta.list_scheduled_runs` | The deployment's recurring jobs: last run, last success, failure counts | `reports.read` | READ | — | no |
| `jeeta.list_team` | List this workspace's team members with their user ids, names, role and status | `reports.read` | READ | — | yes |
| `jeeta.verify_email_transport` | Check whether this deployment can actually send email: a live handshake with the configured SMTP host | `reports.read` | READ | — | no |

#### Leads · Contacts · Tasks · Pipeline

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.search_leads` | Paginated lead search: text, status, source, city/region, priority, assignment, dates | `leads.read` | READ | — | yes |
| `jeeta.create_lead` | Create a lead | `leads.write` | WRITE | — | yes |
| `jeeta.update_lead` | Update a lead's fields | `leads.write` | WRITE | — | yes |
| `jeeta.set_lead_status` | Move a lead's stage, with a timeline entry | `leads.write` | WRITE | — | yes |
| `jeeta.add_lead_note` | Add a note to a lead's timeline | `leads.write` | WRITE | — | yes |
| `jeeta.assign_lead` | Reassign a lead to another rep (manager-tier) | `leads.manage` | WRITE | — | no |
| `jeeta.search_contacts` | Search contacts | `contacts.read` + `leads.read` | READ | — | yes |
| `jeeta.create_contact` | Create a contact | `contacts.write` + `leads.write` | WRITE | — | yes |
| `jeeta.search_companies` | Search companies | `contacts.read` | READ | — | no |
| `jeeta.create_company` | Create a company | `contacts.write` | WRITE | — | no |
| `jeeta.list_segments` | List audience segments | `contacts.read` | READ | — | no |
| `jeeta.list_tags` | List tags | `contacts.read` | READ | — | no |
| `jeeta.list_tasks` | List tasks | `tasks.read` | READ | — | yes |
| `jeeta.create_task` | Create a task and assign it | `tasks.write` | WRITE | — | yes |
| `jeeta.complete_task` | Mark a task done | `tasks.write` | WRITE | — | yes |
| `jeeta.list_pipelines` | List pipelines and their stages | `leads.read` | READ | — | no |
| `jeeta.list_opportunities` | List deals on a pipeline | `leads.read` | READ | — | yes |
| `jeeta.create_opportunity` | Create a deal | `leads.write` | WRITE | — | yes |
| `jeeta.move_opportunity_stage` | Advance a deal | `leads.write` | WRITE | — | yes |
| `jeeta.delete_opportunity` | Permanently delete a deal | `leads.manage` | DESTRUCTIVE | **DESTRUCTIVE** | no |
| `jeeta.get_distribution_config` | How new leads get an owner: the assignment strategy, and who was assigned last | `settings.manage` | READ | — | no |
| `jeeta.list_companies` | List this workspace's B2B accounts (companies) with their id, name, domain and city | `contacts.read` | READ | — | no |
| `jeeta.list_duplicate_leads` | Find groups of leads that look like the same customer, matched on normalised phone and email across every source | `leads.read` | READ | — | no |
| `jeeta.merge_leads` | Merge duplicate leads into one record; notes, tasks, deals and conversations move across | `leads.write` | DESTRUCTIVE | yes | no |
| `jeeta.reopen_lead` | Send a lead back to NEW when its stage is wrong; requires a manager and a reason | `leads.manage` | WRITE | — | no |
| `jeeta.update_opportunity` | Change a deal's details — name, value, currency, notes, owner, expected close date, or the lead it belongs to | `leads.write` | WRITE | — | no |

#### Inbox

Gated on the `conversationAi` package feature, matching the REST controller.

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_conversations` | List shared-inbox conversations, newest first | `contacts.read` | READ | — | yes |
| `jeeta.read_conversation` | Full message history of one conversation + linked lead/channel | `contacts.read` | READ | — | yes |
| `jeeta.send_message` | Reply in a conversation — **reaches a real customer** | `contacts.write` | WRITE | `SEND` | yes |
| `jeeta.assign_conversation` | Route a thread to a teammate (internal) | `contacts.write` | WRITE | — | no |
| `jeeta.close_conversation` | Close or reopen a thread (internal) | `contacts.write` | WRITE | — | no |
| `jeeta.add_conversation_note` | Internal note on a thread; the customer never sees it | `contacts.write` | WRITE | — | no |
| `jeeta.create_webchat_channel` | Create a WEB CHAT channel for this workspace — the website chat widget | `settings.manage` | WRITE | — | no |
| `jeeta.get_agent` |  | `reports.read` | READ | — | no |
| `jeeta.list_agents` | List this workspace\ + + | `reports.read` | READ | — | no |
| `jeeta.list_channels` | List every messaging channel this workspace has — type, name, status, and which provider identity it is bound to | `settings.manage` | READ | — | no |
| `jeeta.message_lead` | Start a conversation with a chosen lead on SMS, WhatsApp or email | `contacts.write` | WRITE | SEND | no |
| `jeeta.set_channel_status` | Enable or disable a channel | `settings.manage` | WRITE | — | no |
| `jeeta.update_agent` | Refine an AI agent's persona, tone, goals or guardrails | `settings.manage` | WRITE | — | no |
| `jeeta.verify_channel` | Run a live health check against a channel and report whether it can actually send AND receive | `reports.read` | READ | — | no |

See [MCP replies are AI-authored](#mcp-replies-are-ai-authored).

#### Campaigns · Email · Voice

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_campaigns` | List campaigns with channel, status, last-known stats | `campaigns.read` | READ | — | yes |
| `jeeta.get_campaign_performance` | Recipients, sent/failed/skipped, opens/clicks/unsubs for one campaign | `reports.read` | READ | — | yes |
| `jeeta.create_campaign` | Compose an email/SMS campaign as a DRAFT | `campaigns.write` | WRITE | — | yes |
| `jeeta.set_campaign_status` | Launch / pause / cancel — **reaches real customers** | `campaigns.send` | WRITE | `PUBLISH` | yes |
| `jeeta.list_email_templates` | List saved email templates | `campaigns.read` | READ | — | yes |
| `jeeta.send_email` | Email one lead — composed as a one-recipient campaign so opt-out, bounce suppression and the unsubscribe footer all apply | `campaigns.send` | WRITE | `SEND` | yes |
| `jeeta.click_to_dial` | **Place a real outbound phone call** to a lead | `leads.write` | WRITE | `SEND` | yes |
| `jeeta.list_calls` | Call history | `leads.read` | READ | — | no |
| `jeeta.create_voice_campaign` | Compose a voice campaign (does not launch it) | `campaigns.write` | WRITE | — | no |

Campaign tools gate on `campaigns`; voice on `voiceCampaigns`.

#### Social · Content

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_social_accounts` | Connected social accounts and their ids | `campaigns.read` | READ | — | yes |
| `jeeta.list_scheduled_posts` | List social posts; defaults to `SCHEDULED` | `campaigns.read` | READ | — | yes |
| `jeeta.get_social_post` | One post with its media and target accounts | `campaigns.read` | READ | — | no |
| `jeeta.draft_social_post` | Create a DRAFT post — no external side effect | `campaigns.write` | WRITE | — | yes |
| `jeeta.update_social_post` | Edit a draft/scheduled post | `campaigns.write` | WRITE | — | no |
| `jeeta.schedule_social_post` | Schedule a post to go out later — **reaches a real audience** | `campaigns.send` | WRITE | `PUBLISH` | yes |
| `jeeta.publish_social_post` | Publish now to every attached account — **reaches a real audience** | `campaigns.send` | WRITE | `PUBLISH` | yes |
| `jeeta.delete_social_post` | **Permanently delete** a post | `campaigns.write` | **DESTRUCTIVE** | **`DESTRUCTIVE`** | no |
| `jeeta.list_social_campaigns` | List social campaigns | `campaigns.read` | READ | — | no |
| `jeeta.create_social_campaign` | Create a social campaign | `campaigns.write` | WRITE | — | no |
| `jeeta.get_content_calendar` | Everything scheduled in a date range across channels | `reports.read` | READ | — | yes |
| `jeeta.generate_image` | AI image generation — **spends real money (fal.ai)** | `campaigns.send` | **SPEND** | **`MEDIA_SPEND`** | yes |
| `jeeta.generate_video` | AI video generation — **spends real money (fal.ai)** | `campaigns.send` | **SPEND** | **`MEDIA_SPEND`** | no |
| `jeeta.list_generated_media` | Previously generated assets | `campaigns.read` | READ | — | no |
| `jeeta.pause_social_campaign` | Pause a RUNNING AI social campaign and cancel its scheduled plan job | `campaigns.write` | WRITE | CAMPAIGN_PAUSE | no |
| `jeeta.unschedule_social_post` | Pull a SCHEDULED post back to DRAFT so its copy, media or targets can be corrected, then schedule it again | `campaigns.send` | WRITE | — | no |

Media generation gates on `mediaGen`; social campaigns on `socialCampaigns`.

#### Ads

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.get_ad_performance` | Spend/impressions/clicks/leads/revenue over a range, totals + by-day + by-provider | `reports.read` | READ | — | yes |
| `jeeta.get_budget` | Growth Autopilot budget(s): amount, target ROAS/CAC, channel allocations | `reports.read` | READ | — | no |
| `jeeta.reallocate_budget` | Change a live daily budget on a connected ad account — **spends real money** | `settings.manage` | **SPEND** | **`BUDGET_REALLOCATION`** | yes |
| `jeeta.list_ad_accounts` | List the ad accounts connected to this workspace (id, provider, display name, status, currency) | `reports.read` | READ | — | no |

#### Strategy · Workflows · Research

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.get_strategy` | The workspace's marketing strategy brief | `reports.read` | READ | — | yes |
| `jeeta.list_strategy_actions` | The Strategy Engine's proposed action plan | `reports.read` | READ | — | yes |
| `jeeta.approve_strategy_action` | Approving **executes** the action (research spend, live post, AI credits, ad write) | `settings.manage` | **SPEND** | **`STRATEGY_ACTION`** | yes |
| `jeeta.dismiss_strategy_action` | Drop a proposed action | `settings.manage` | WRITE | — | no |
| `jeeta.synthesize_strategy` | Re-synthesise the strategy — **burns AI credits + live scraping money** | `settings.manage` | **SPEND** | **`AI_SPEND`** | no |
| `jeeta.set_strategy_autonomy` | Change the strategy lane (cannot select `AUTONOMOUS`) | `settings.manage` | WRITE | `TARGET_CHANGE` | no |
| `jeeta.list_workflows` | List automations and their status | `automations.manage` | READ | — | yes |
| `jeeta.get_workflow` | One automation's trigger and steps | `automations.manage` | READ | — | no |
| `jeeta.create_workflow` | Author an automation as a DRAFT (it does not run) | `automations.manage` | WRITE | — | no |
| `jeeta.set_workflow_enabled` | **Arm** an automation — it starts acting on every future matching lead | `automations.manage` | WRITE | `CHANNEL_LAUNCH` | no |
| `jeeta.trigger_workflow` | Run an armed automation over real leads now — **sends + AI spend** | `automations.manage` | **SPEND** | **`SEND`** | no |
| `jeeta.list_research_profiles` | Prospect-research briefs + today's remaining lead allowance | `settings.manage` | READ | — | yes |
| `jeeta.create_research_profile` | Create a research brief (costs nothing on its own) | `settings.manage` | WRITE | — | no |
| `jeeta.run_research` | Run a brief now — **burns AI credits + live scraping money** | `settings.manage` | **SPEND** | **`AI_SPEND`** | no |
| `jeeta.accept_research_candidates` | Accept staged prospects and turn them into real leads in the CRM | `leads.write` | WRITE | yes | no |
| `jeeta.list_research_candidates` | Prospects the research agent staged for review, with the pain signal it found | `settings.manage` | READ | — | no |
| `jeeta.pause_research_profile` | Stop a research brief from running | `settings.manage` | WRITE | — | no |
| `jeeta.reject_research_candidates` | Dismiss staged prospects that are not a fit, removing them from the review queue without creating leads | `leads.write` | WRITE | yes | no |

Workflows gate on `workflows`; research on `research`.

##### The MCP research lane

Live measurement put the nightly research agent at **86% of the platform's whole
Anthropic bill** — and the `@Cron` that builds those jobs spends nothing. All of
the money is spent by whoever *drains* the queue. So the queue can be drained by
the workspace's **own Claude**, with the reasoning and general web search billed
to the owner's subscription instead.

`researchExecution` decides **who is asked first**, and has three values:

| Value | Behaviour |
| --- | --- |
| `AUTO` (default) | `MCP` while a Claude is actually connected to this workspace, `SERVER` otherwise |
| `SERVER` | the platform's in-process worker drains immediately |
| `MCP` | the owner's Claude gets first refusal |

**It is not a hard switch, and that is deliberate.** Under `MCP` the platform
stays off a research job only while it is within `RESEARCH_MCP_GRACE_HOURS` (6)
of being enqueued; after that it drains the job anyway, on its own key. The
first version of this lane *was* a hard switch, and a customer who connected
Claude once and never wrote a scheduled task had their nightly research stop
dead while the panel showed an empty review queue — indistinguishable from
"research found nothing". The grace window makes *"research never silently
stops"* a system-wide invariant, which is the only reason `AUTO` is safe as a
default: a wrong guess costs six hours of latency, never a night's work.

The connection `AUTO` looks for is an `agent_runs` row with `agent = 'mcp'`
inside `MCP_CONNECTION_STALE_DAYS` (14) — i.e. a real MCP **tool call**, on
either the API-key or the OAuth path. Deliberately *not* `ApiKey.lastUsedAt`,
which the public REST `ApiKeyGuard` stamps as well (a Zapier integration would
have flipped the lane) and which the Claude.ai/Desktop connectors never touch
at all.

When the platform does take a job back, **it says so**: the takeover is stamped
on the job with its measured vendor cost, and the home timeline reports it by
name — *"your Claude did not take the job, we ran it: N nights ($X) — is your
scheduled task running?"*. A fallback that quietly keeps the cost on the
platform is the same trap as a lane that silently stops, approached from the
other side.

The switch lives in **Settings → Claude connector**, on the *"Who runs the
nightly research"* card, which also says whether the current lane was **chosen
or detected**, and is OWNER-only
(`PATCH marketing/workspaces/research-execution`, `@Audit`-logged). The same
page hands over a **copy-paste scheduled-task prompt** with this workspace's
connector address already in it; the first-run checklist's *"Connect your
Claude"* step points there, and is completed only by a real successful claim —
never by the existence of a key.

The instruction is **server-authored**. `jeeta.claim_research_job` returns the
whole brief — ICP, geo, business types, exclusions, language, the hard
disqualifiers, the `externalRef` dedup convention and the output contract — from
the same `research-contract.ts` the in-process worker reads, so lead quality does
not depend on how the owner phrased their scheduled task.

A job is **leased**, not just read: `PENDING -> CLAIMED -> DONE|FAILED`, with the
flip taken by one conditional `UPDATE ... WHERE status = 'PENDING'`. Two holders
would mean one night researched — and billed — twice. An expired lease returns to
the queue, so a crashed client cannot hold a night hostage.

`CLAIMED` is deliberately a status the generic sweepers do not know (`claimBatch`
takes `PENDING`, `reapStuck` revives `RUNNING`), which means the ONLY thing that
can move such a row is this lane's own expiry sweep. That sweep therefore runs
from **two** places — on the way into a claim, and on every `queueStatus()` read
(the home timeline, on load and on its 60-second refetch). The second is not
redundant: nothing claims a `SERVER` queue, so a job left `CLAIMED` when an owner
flips back to `SERVER` — or when a client crashes and stops polling — would
otherwise be stranded permanently, and invisibly. The home timeline reports
`claimed` and the age of the oldest lease alongside `pending`, because a fully
*held* queue reads `pending: 0`, the same zero as a healthy empty one.

`search_web` is deliberately **not** exposed: the owner's Claude does its own
searching, and that is where the platform's `research.native_search` spend goes.
The three tools below stay on **Jeeta's** Apify/Firecrawl keys — their cost does
not move — because Google Maps listings and their recent reviews are the primary
source of the pain signal every candidate is qualified on, and general web search
cannot reach them.

| Tool | What it does | Scope | Risk | Gated | Listed |
| --- | --- | --- | --- | --- | --- |
| `jeeta.claim_research_job` | Lease the next queued nightly job and get its full brief | `settings.manage` | WRITE | — | no |
| `jeeta.submit_research_candidates` | Hand back the prospects found, as review **candidates** (not leads) | `settings.manage` | WRITE | yes | no |
| `jeeta.complete_research_job` | Close a leased job, successfully or with the reason it failed | `settings.manage` | WRITE | — | no |
| `jeeta.research_search_places` | Google Maps listings + recent reviews inside the job's geo — **Apify money** | `settings.manage` | **SPEND** | **`AI_SPEND`** | no |
| `jeeta.research_lookup_instagram` | Confirm a reachable social channel for one handle — **Apify money** | `settings.manage` | **SPEND** | **`AI_SPEND`** | no |
| `jeeta.research_scrape_page` | Fetch one page as markdown for evidence — **Firecrawl money** | `settings.manage` | **SPEND** | **`AI_SPEND`** | no |

`claim` and `complete` are ungated: claiming spends nothing and self-reverses on
expiry, and gating the *close* would leave the job leased until it expired and
then researched a second time — a gate that costs money instead of saving it.

The three SPEND tools are gated exactly like every other SPEND in this
catalogue, and it is worth being exact about what that costs, because it is
**not a delay**. `McpApprovalExecutorService.apply()` returns the tool result to
the approving human's HTTP response; it does not resume the agent's turn. For a
**terminal write** that is harmless — `submit_research_candidates` is replayed
on approval with the candidates intact, which is why it survives the gate. For a
**data fetch** it is fatal: under `APPROVAL` the drainer receives
`PENDING_APPROVAL` and can never obtain the Maps listings *within its session*,
however fast the owner clicks, and both the 30-minute lease and the 24-hour
approval TTL run out first.

So under `APPROVAL` the three vendor tools are not queued, they are **unusable**,
and the lane silently degrades to Claude's own web search — losing exactly the
Google Maps pain signal this design calls unsubstitutable. **Running this lane as
designed requires `AUTONOMOUS` write mode.** What `APPROVAL` genuinely delays is
the submit: each night's candidates wait for a human click, and the home timeline
reports that by name rather than letting it look like an empty review queue.

#### Scheduling

Gated on the `funnels` package feature, matching the REST controller.

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_bookings` | Real bookings (not external busy blocks), by calendar/status/range | `tasks.read` | READ | — | yes |
| `jeeta.get_booking_availability` | Bookable slot starts, honouring hours/buffers/notice/blackouts | `tasks.read` | READ | — | no |
| `jeeta.create_booking` | Book a real appointment — **emails the attendee a confirmation + invite, mirrors it into the connected Google/Outlook calendar, creates a contact, takes a teammate's slot** | `settings.manage` | WRITE | `SEND` | no |
| `jeeta.list_calendars` | List this workspace's booking calendars with their id, name, slug, slot length and timezone | `tasks.read` | READ | — | no |

Cancel and reschedule are deliberately not tools: both message the attendee
again and act on a commitment a human already made.

#### Commerce

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_products` | Product catalogue — prices are decimals in **major** units | `leads.read` | READ | — | yes |
| `jeeta.create_product` | Add a catalogue item (sells nothing, charges nobody) | `leads.manage` | WRITE | — | no |
| `jeeta.list_invoices` | Recent invoices to the workspace's own customers (totals in **minor** units) | `settings.manage` | READ | — | no |
| `jeeta.create_estimate` | A DRAFT quote — nothing is sent; line prices are **minor** units | `leads.write` | WRITE | — | no |
| `jeeta.send_invoice` | Text the customer their pay link over SMS/WhatsApp — **reaches a real person and asks for money** | `settings.manage` | WRITE | `SEND` | no |
| `jeeta.list_order_forms` | Public checkout pages and their tokens | `leads.read` | READ | — | no |

Invoicing tools gate on `invoicing`; products, estimates and order forms are
not gated, because the REST controllers do not gate them either.

`jeeta.send_invoice` wraps the **text-to-pay** path, not `InvoicesService.send`.
The latter — what the panel's "Send / copy pay link" button calls — reaches
nobody: it flips the status to `SENT` and hands back a URL for a human to paste,
and there is no email-an-invoice code anywhere in the module. So "send" here
means an SMS or WhatsApp message actually goes to the customer.

Marking an invoice paid, voiding one, and debiting a customer's stored wallet
are **not** tools — see [What is never a tool](#what-is-never-a-tool).

#### Courses

Gated on `memberships` — deliberately stricter than REST, which only hides the
nav entry. It is a Settings > Modules toggle new workspaces start with off.

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_courses` | Courses with status, price and how lessons unlock | `courses.manage` | READ | — | yes |
| `jeeta.enrol_lead` | Enrol a contact. **Internal record only** — no welcome email, no credentials, no charge; idempotent | `courses.manage` | WRITE | — | no |

#### Reviews

Gated on `reviews`, matching the REST controller.

| Tool | What it does | Scope | Risk | Gated | Listed |
|---|---|---|---|---|---|
| `jeeta.list_reviews` | Recent reviews and review requests with their status | `settings.manage` | READ | — | yes |
| `jeeta.reply_to_review` | Write the business's reply and mark the review replied | `settings.manage` | WRITE | `PUBLISH` | no |

**`jeeta.reply_to_review` does not publish to Google or Facebook.**
`ReviewsService.saveReply` writes `replyText` and flips `status` to `REPLIED`;
there is no Google Business Profile reply call anywhere in the codebase (the
review clients only ever GET, and the `business.manage` OAuth scope is requested
but never used for a write). Someone still has to paste the text into the
platform. It is approval-gated anyway, for two reasons: the words are the
brand's public voice one copy-paste from publication, and the `REPLIED` flip
takes the review out of the team's queue — a complaint marked answered that
nobody answered is worse than an unanswered one.

### What is never a tool

Design spec §7, enforced by absence and re-asserted per wave:

- **Deciding an approval.** No tool approves, rejects or applies an
  `ApprovalRequest`. That is the human gate the whole queue exists for.
  (`jeeta.approve_strategy_action` approves a *strategy proposal*, not an
  approval request — and it is itself gated in every mode.)
- **User and role management.** `users.manage` is not in `MCP_ALL_SCOPES`; no
  tool can create users, change roles or grant permissions.
- **Workspace creation and package assignment.** The tenant/billing boundary;
  `billing.manage` is likewise absent from the MCP vocabulary.
- **Minting API keys.** An agent that can mint credentials escapes every scope
  it was given.
- **Settling money.** No `mark_invoice_paid`, `void_invoice`, `pay_with_wallet`,
  refund or `submit_order_form`. Recording a payment that never arrived,
  cancelling a live receivable and debiting a stored balance all have accounting
  consequences no audit log undoes — and only a human or a PSP callback can know
  the money moved. `d5-isolation.spec.ts` pins that no such tool exists.
- **Completing a lesson on a learner's behalf**, which fabricates a record of
  learning and can mint a certificate in their name.
- **Authoring courses**, **creating order forms**, **connecting a review
  source** — setup a human finishes anyway, and a half-created one is worse than
  none.

## Approval-gated tools

**30 of the 114 tools are registered `requiresApproval: true`** — the ones that
reach a customer, speak to an audience, spend money or delete something. See
the Gated column in [the catalogue](#the-catalogue) for the full list; the
short version is:

- **reaches a named person:** `jeeta.send_message`, `jeeta.send_email`,
  `jeeta.click_to_dial`, `jeeta.send_invoice`, `jeeta.create_booking`
- **reaches an audience:** `jeeta.set_campaign_status`,
  `jeeta.publish_social_post`, `jeeta.schedule_social_post`,
  `jeeta.reply_to_review`
- **spends real money (gated in EVERY mode):** `jeeta.reallocate_budget`,
  `jeeta.generate_image`, `jeeta.generate_video`,
  `jeeta.approve_strategy_action`, `jeeta.synthesize_strategy`,
  `jeeta.run_research`, `jeeta.trigger_workflow`
- **destroys a row (gated in EVERY mode):** `jeeta.delete_social_post`
- **hands over authority:** `jeeta.set_workflow_enabled` (arms an automation),
  `jeeta.set_strategy_autonomy`

When one of these is called and the workspace is in the default `APPROVAL`
write mode, `McpBrokerService.invoke` **never runs the tool's handler**. It
instead creates a row in `approval_requests`
(`kind` = the tool's `approvalKind`, `payload` = `{ tool, args }`,
`status = 'PENDING'`) and returns immediately. The MCP response back to the
model is not an error — it's a successful result whose text says explicitly:

> Queued for human approval (approvalId: …). It has NOT been applied yet.

(`McpServerFactoryService.handlerFor` — worded this way on purpose, so the
model doesn't report the action as done.)

A human with **OWNER/MANAGER** reviews the queue and, for each request, makes
**two** separate calls — decide, then execute:

```bash
# List requests still needing attention: PENDING (undecided) AND
# APPROVED-but-not-yet-applied (decided, execution still outstanding).
# reports.read is enough to view.
GET /api/marketing/approvals

# Decide (settings.manage + MANAGER role required). Only a PENDING row can
# be decided; re-deciding an already-decided row 400s.
POST /api/marketing/approvals/:id/approve
POST /api/marketing/approvals/:id/reject

# Execute an APPROVED request for real (settings.manage + MANAGER role
# required) — runs the original MCP tool call through the same broker a live
# request goes through.
POST /api/marketing/approvals/:id/apply
```

(`backend/src/modules/marketing/controllers/marketing-approvals.controller.ts`)

**Approving alone still does not act — apply does.** `approve()`
(`ApprovalRequestService.decide`) only flips `status` from `PENDING` to
`APPROVED` and records who decided and when; it does not touch the customer,
the campaign, the post, or the ad account. `POST …/:id/apply`
(`MarketingApprovalsController.apply` → `McpApprovalExecutorService.apply`) is
what actually runs the tool:

1. It atomically claims the row (`APPROVED` → `APPLYING`, via
   `ApprovalRequestService.claimForApply`) *before* touching anything else —
   this is what makes two concurrent apply attempts on the same request
   at-most-once-safe: the loser is rejected at the claim (400 `cannot apply a
   APPLYING request`), never after a duplicate send has already gone out.
2. It re-invokes the original tool — whichever of the 19 gated ones it was —
   through `McpBrokerService.invoke`, with
   `ctx.approvedBy = { approvalId, userId }` set — that flag is what makes the
   broker run the handler inline this time even though the workspace is still
   in `APPROVAL` mode (`tool.requiresApproval && writeMode !== 'AUTONOMOUS' &&
   !approvedBy` is the enqueue condition; `approvedBy` short-circuits it). The
   tool runs under its own registered scope (least privilege), not the
   original API key's scopes — the human who approved it, via `settings.manage`,
   is the authority for this specific execution.
3. On success, the row moves → `APPLIED` (`appliedAt` set). On failure —
   meaning the tool never ran — the row moves back `APPLYING` → `APPROVED` so
   an operator can retry, and the original error is re-thrown untouched, never
   swallowed.

   Once the tool HAS run, that direction is closed for good: the request is
   recorded `APPLIED` and the caller is told `APPLIED`, whatever happens next.
   `finishApply` retries a failed write, and accepts `APPROVED` as well as
   `APPLYING` so an execution the reaper pre-empted (below) still lands
   `APPLIED` when it finishes. If the record still cannot be written, the
   failure is raised on the **server log** and the response is still
   `APPLIED` — because the alternative, reporting the action as failed,
   invites an operator to click Apply again and re-send a message the
   customer already received.

So an approved `jeeta.send_message` genuinely sends the message,
`jeeta.publish_social_post` genuinely publishes, `jeeta.reallocate_budget`
genuinely pushes the live budget change, `jeeta.send_invoice` genuinely texts
the customer, `jeeta.create_booking` genuinely takes the slot and emails the
attendee, and `jeeta.delete_social_post` genuinely deletes — but only after
**both** calls, not after approve alone.

**Full lifecycle:** `PENDING` → (`approve`) → `APPROVED` → (`apply`, claims) →
`APPLYING` → (tool succeeds) → `APPLIED`, or `APPLYING` → (tool throws) → back
to `APPROVED` (retryable). `PENDING` → (`reject`) → `REJECTED`. A `PENDING`
row past its `expiresAt` flips to `EXPIRED` the next time anyone tries to
decide it, instead of being decided.

**A crash mid-`apply` is reclaimed, not left stranded.** While a tool call is
in flight, `McpApprovalExecutorService` re-stamps the row's `updatedAt` every
15s (`APPLYING_HEARTBEAT_MS`, `ApprovalRequestService.touchApplying`). A
`@Cron(EVERY_10_MINUTES)` job (`ApprovalRequestService.reapStaleApplying`)
sweeps any row still `APPLYING` whose heartbeat has gone silent for over 60s
(`STALE_APPLYING_MS`, 4× the heartbeat interval) back to `APPROVED` — never to
`APPLIED`, because whether the call actually completed before the process
died is exactly the unknown a stranded row represents; an operator decides
whether to retry. A genuinely slow multi-account or carousel publish (these
can legitimately run 15+ minutes) is never falsely reclaimed, because it keeps
heartbeating the whole time.

If the sweep does reclaim a row whose call was still alive — a heartbeat
silenced past 60s by an event-loop stall or a database blip — the mistake is
not permanent: that execution's `finishApply` still records `APPLIED` when it
returns, pulling the request back out of the queue. What remains is a window,
not a wrong resting state: an operator who clicks Apply during it re-sends.
Closing it needs a durable execution record the reaper can consult, tracked as
issue #152.

**Where to act on this today:** the API above, or the Growth Autopilot page's
**Approvals** tab (`frontend/src/pages/marketing/budget/BudgetAutopilotPage.tsx`
→ `ApprovalsTab`) — this is the *only* frontend surface for the approval
queue; there is no dedicated MCP-approvals inbox (tracked separately, not part
of this activation). It calls the same generic `/approvals` endpoints, renders
the MCP tool name and its arguments (not just the generic summary sentence) so
a reviewer can see the actual text/target/amount before approving, and shows a
row whose `status` is already `APPROVED` with an **"Approved — not applied
yet"** badge and a single **Apply** button (never Approve/Reject again — those
would 400 on an already-decided row). Two caveats: that tab only renders when
a Growth Budget has been provisioned for the workspace, and only while that
budget's own autonomy switch is **not** armed (`ASSISTED`, not `AUTONOMOUS` —
a separate, per-budget concept from `Workspace.mcpWriteMode` below, which
happens to share the UI). Without a Growth Budget, or with one armed, the
queue is API-only.

## Write mode: APPROVAL vs AUTONOMOUS

`Workspace.mcpWriteMode` (Postgres column `workspaces."mcpWriteMode"`,
`TEXT NOT NULL DEFAULT 'APPROVAL'`) controls this per workspace. Read fresh on
every call (`McpInvokerService.writeModeFor`) — no caching, so a mode change
takes effect on the very next tool call, and any value other than the literal
string `'AUTONOMOUS'` behaves as `APPROVAL` (fail-safe default).

**What changes:** in `AUTONOMOUS` mode, gated tools whose risk is `WRITE` run
their handler **inline, immediately, with no human in the loop** —
`jeeta.send_message` sends the message right away, `jeeta.send_email` emails
the lead right away, `jeeta.click_to_dial` dials right away,
`jeeta.publish_social_post` publishes right away, `jeeta.send_invoice` texts
the customer the payment demand right away, `jeeta.create_booking` books the
appointment and emails the attendee right away, `jeeta.reply_to_review` writes
in the business's name right away. Nothing is queued and there is nothing to
approve or apply — the model's tool call *is* the action.

**What does NOT change, in any mode:** a tool whose risk is `SPEND` or
`DESTRUCTIVE` is **always** queued for a human. `ALWAYS_APPROVED_RISKS` in
`mcp-broker.service.ts` is unconditional on write mode, so autonomy cannot move
an ad budget, run an AI generation, execute a strategy action, launch a research
run, fire a workflow over real leads, or delete a post. `AUTONOMOUS` is a
statement about SPEED ("stop making me approve every send"), not a power of
attorney: money spent and rows deleted are the two things noticing an hour later
does not undo. `mcp-broker.destructive.spec.ts` pins both directions.

Read [Approval-gated tools](#approval-gated-tools) and the Gated column in
[the catalogue](#the-catalogue) so you know exactly which 11 tools this frees
before turning it on for a workspace.

**What does not change:** every call — gated or not, in either mode, whether
it runs inline or via a later `apply` — still opens an `agent_runs` row first
(see [Audit trail](#audit-trail)); the 32 KB argument cap and scope check
still apply; and a gated tool that runs inline in `AUTONOMOUS` mode still
writes its `tool_call_logs` row afterward, exactly as an ungated tool does
(verified by `mcp-broker.writemode.spec.ts`: "still writes the audit log in
AUTONOMOUS mode"). Switching modes also does not touch any request already
sitting in the approval queue — a `PENDING` or `APPROVED` row from before the
switch still needs a human to approve/apply it (or reject it); flipping to
`AUTONOMOUS` only changes how *new* gated tool calls are handled going
forward.

**Who can flip it, and how:**

```bash
# Read the current mode (OWNER only)
GET /api/marketing/workspaces/mcp-write-mode

# Set it (OWNER only, and settings.manage — both required)
PATCH /api/marketing/workspaces/mcp-write-mode
Content-Type: application/json
{"mode": "AUTONOMOUS"}   # or "APPROVAL" to revert
```

(`MarketingWorkspacesController.getMcpWriteMode` /
`.setMcpWriteMode` → `MarketingAuthService`, guarded
`@MarketingRoles('OWNER')` — a single, never-co-listed role, since this
codebase's hierarchical role guard treats a co-listed lower role as
inclusive-down, not additive — plus `@RequirePermission('settings.manage')`
on the write route.) Any value other than the literal strings `APPROVAL` or
`AUTONOMOUS` in the request body is rejected with a 400 before it reaches the
workspace (`SetMcpWriteModeDto`'s `@IsIn(['APPROVAL', 'AUTONOMOUS'])`). The
workspace acted on is always the caller's own, taken from the authenticated
session — never from the request body or a path param, so no OWNER can flip
another workspace's gate. Both the read and the write are `@Audit`-logged
(`workspace.mcp_write_mode.read` / `.update`), so there is a durable record of
who checked or changed this setting and when.

There is still no UI toggle for this switch — only the two REST routes above.
Because it is the single most safety-sensitive setting this connector has (it
removes the human from every future send/publish/spend the AI decides to
make), treat it accordingly: confirm you understand what the 11
non-`SPEND`/`DESTRUCTIVE` gated tools can do
(see [Approval-gated tools](#approval-gated-tools)) before setting a production
workspace to `AUTONOMOUS`.

## Audit trail

Every MCP tool call — read or write, gated or not, successful or not — opens
one `agent_runs` row (`agent = 'mcp'`, `goal` = the tool name, `input` = the
call arguments) via `AgentRunService.track()`, wrapping the entire call
(`McpInvokerService.invoke`). The run is marked `DONE` with the tool's result
as `output`, or `FAILED` with the error message, when the call finishes.

A **separate** `tool_call_logs` row (`tool`, `args`, `result`, `ok`,
`error`, `latencyMs`) is written by `McpBrokerService` — but only when the
tool's handler actually executes. For an ungated tool, or a gated tool
running in `AUTONOMOUS` mode, that's every time. For a gated tool queued for
approval in `APPROVAL` mode, the handler never runs at *that* point, so **no
`tool_call_logs` row is written for the original call** — only the
`agent_runs` row (whose `output` shows
`{"status":"PENDING_APPROVAL","approvalId":"…"}`).

**An approval-applied call is written to the audit trail as a distinct,
second run — this is how you tell it apart from one that ran autonomously or
inline.** When a human hits `POST /approvals/:id/apply`,
`McpApprovalExecutorService.apply` opens its **own** `agent_runs` row via
`AgentRunService.track()`, with `goal` set to `` apply approval <approvalId>: <toolName> ``
— not the bare tool name. Compare that to the `goal` on every other MCP call
(`McpInvokerService.invoke` sets `goal: toolName`, nothing more, whether the
call ran inline immediately, ran inline because the workspace is
`AUTONOMOUS`, or was the original enqueue of a now-approved request). So:

- A bare `goal` (e.g. `jeeta.send_message`) with a `tool_call_logs` row under
  it → ran inline, either because the tool isn't gated or because the
  workspace was `AUTONOMOUS` at that moment.
- A bare `goal` with **no** `tool_call_logs` row and an
  `output` of `{"status":"PENDING_APPROVAL",...}` → the original enqueue of a
  gated call in `APPROVAL` mode; nothing executed yet.
- A `goal` starting with `apply approval …: ` → a human approved this
  specific `approvalId` and then applied it; the tool ran for real under this
  run, and its `tool_call_logs` row is nested under *this* run, not the
  original enqueue run. There is no formal foreign key between the two
  `agent_runs` rows — the link is the `approvalId` embedded in the second
  run's `goal` string (and in `approval_requests.id` itself).

**To inspect it as an operator:**

```bash
# Requires a marketing session with reports.read (any role, including REP)
GET /api/marketing/approvals/agent-runs
```

returns the workspace's `AgentRun` rows (newest first) with their nested
`toolCalls` (`ToolCallLog` rows) included
(`MarketingApprovalsController.agentRuns` → `AgentRunService.list`).

With direct database access:

```sql
SELECT id, agent, goal, status, "startedAt", "finishedAt"
FROM agent_runs
WHERE "workspaceId" = '<workspace-id>' AND agent = 'mcp'
ORDER BY "startedAt" DESC
LIMIT 20;

SELECT tool, ok, "latencyMs", error, "createdAt"
FROM tool_call_logs
WHERE "runId" = '<agent-run-id>'
ORDER BY "createdAt";
```

A crash-recovery cron (`AgentRunService.reapStaleRuns`, every 10 minutes)
marks any `agent_runs` row stuck `RUNNING` for over an hour as `FAILED` — so a
run left permanently `RUNNING` in this table means the process died mid-call,
not that the call is still in flight. A separate cron
(`ApprovalRequestService.reapStaleApplying`, also every 10 minutes) does the
equivalent job for `approval_requests`: see
[Approval-gated tools](#approval-gated-tools) for how it uses a heartbeat,
not elapsed time, to tell a crashed `apply` apart from a legitimately slow
one.

## Known, deliberate properties

### Lead search sees the whole workspace (API-key sessions only)

**This applies to the API-key path only.** On an OAuth session
([mcp-oauth-connector.md](./mcp-oauth-connector.md)) the caller IS a user, so
`findAll` runs with their real id and the role they currently hold in that
workspace — a REP sees exactly the leads they see in the app. The rest of this
section describes the API-key path, where there is no user to narrow by.

`jeeta.search_leads` calls `MarketingLeadsService.findAll` with a synthetic
principal (`MCP_NON_REP_PRINCIPAL` in
`backend/src/modules/marketing/mcp/tools/leads.tools.ts`:
`{ userId: 'mcp-service-principal', role: 'MANAGER' }`), because an API-key
MCP session has no human user attached to it. The practical effect: **an MCP
lead search is not narrowed by assignee the way a REP's own view in the app
would be — it can see every lead in the workspace**, the same breadth an
OWNER or MANAGER has.

This is intentional, not an oversight, and it does not affect tenant
isolation — `findAll` scopes by `workspaceId` unconditionally regardless of
the principal, and the granted role only ever widens or leaves unchanged the
*within-workspace* visibility (`findAll` only special-cases the literal
string `'REP'`; every other role, including the synthetic `'MANAGER'` used
here, is treated identically). The alternative — using `'REP'` — would have
been actively wrong: it would filter to `assignedToId === 'mcp-service-principal'`,
an id that owns no real leads, so the tool would have silently returned zero
results for every workspace. This was reviewed and signed off during
implementation (see `.superpowers/sdd/2026-07-28-mcp-connector-faz1-2/progress.md`,
Task 8) as the correct behavior for an API-key session. Faz 3's OAuth path
(user-bound, not workspace-key-bound) is where per-user narrowing came back —
it is live, and it is another reason to prefer OAuth where the client supports
it.

### MCP replies are AI-authored

When `jeeta.send_message` sends a reply, it's recorded with
`authorType: 'AI'` and `authorId: null`
(`ConversationsService.replyAsAi` → `sendTakeoverReply`), not attributed to
any human agent — because an API-key MCP session has no human user to
attribute it to, and the reply genuinely was composed by the model, not a
person. Sending also flips the conversation's `aiPaused` flag to `true`
(the same "a reply from outside the AI engine is a takeover" rule that
applies to a human agent's reply), so Jeeta's own AI responder won't also
answer the thread.

## Troubleshooting

- **`403 Forbidden`, `missing scope(s): …`** — the key's expanded scopes
  don't cover everything the tool requires. See [Scopes](#scopes); most
  commonly this is a key minted with only the legacy `read`/`write` shorthands
  trying to reach a tool that needs `contacts.write`, `campaigns.write`,
  `campaigns.send`, `leads.manage`, `courses.manage`, `automations.manage` or
  `settings.manage` — none of which any legacy shorthand expands into. Mint (or
  add to) a key with the specific granular scope instead.
- **A tool call comes back with `isError: true` and a message** instead of a
  thrown request failure — this is intentional
  (`McpServerFactoryService.handlerFor`): a scope refusal, an oversized
  argument payload, or an unknown tool name is surfaced as a structured tool
  result so the model can read the reason and adjust, rather than the whole
  MCP request failing.
- **A tool you expect isn't in the list** — two possible reasons. It may be
  **deferred**: only 45 of the 114 tools are advertised, and the other 67 are
  reached by asking the model to call `jeeta.find_tools` and then
  `jeeta.call_tool` (see
  [Progressive disclosure](#progressive-disclosure)). Or the key's scopes may
  not cover it — the server only advertises tools the granted scopes fully
  satisfy (`McpToolRegistry.listAdvertised`), and `jeeta.find_tools` applies the
  same filter, so a caller cannot even see the existence of a tool it can't
  call.
- **`POST /approvals/:id/apply` returns `400 cannot apply a <STATUS> request`**
  — `apply` only accepts a row currently `APPROVED`. `PENDING` means nobody
  has approved it yet (approve first); `APPLIED`/`REJECTED`/`EXPIRED` are
  terminal; `APPLYING` means another `apply` call is already in flight for
  this request right now (wait for it, or for the reaper to reclaim it if it
  crashed — see [Approval-gated tools](#approval-gated-tools)).
- **A tool returns `403 FEATURE_NOT_IN_PACKAGE`** — the workspace's package (or
  its Settings > Modules toggles) does not include the module that tool belongs
  to. MCP makes the same entitlement check the REST controller makes
  (`mcp-feature-gate.ts`), so this is not an MCP-specific refusal: `invoicing`,
  `conversationAi`, `funnels`, `campaigns`, `workflows`, `research`, `mediaGen`,
  `socialCampaigns`, `voiceCampaigns`, `reviews` and `memberships` all gate
  tools. The error names the feature. (`memberships` and `research` are gated
  more strictly over MCP than over REST — see
  [Tool catalogue](#tool-catalogue).)
- **`POST /approvals/:id/apply` returns `400 Approval request is not an MCP
  tool invocation`** — this route only executes requests whose `payload` is
  the `{ tool, args }` shape `McpBrokerService.invoke` enqueues. A Growth
  Autopilot reallocation proposal (payload `{ budgetId, after: [...] }`) uses
  a different route: `POST /budget/reallocations/:approvalId/apply`.
- **A queued request never gets applied** — approve and apply are two
  separate calls; approving alone does nothing outward-facing. Check
  `GET /api/marketing/approvals` (or the Growth Autopilot page's Approvals
  tab) for a row still sitting `APPROVED` and apply it, or retry apply if it
  previously failed.
