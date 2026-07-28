# Jeeta MCP Connector

Jeeta exposes a curated set of workspace tools over the [Model Context
Protocol](https://modelcontextprotocol.io) (Streamable HTTP transport), so an
external agent — e.g. Claude with the `claude mcp` CLI — can read workspace
data (leads, conversations, campaigns, ad performance, bookings, …) and, with
a human in the loop by default, take actions (reply to a customer, launch a
campaign, publish a social post, move ad budget).

This guide is for the person setting the connector up for a workspace, not
for the engineer who built it.

## Status — read this before you start

- **No one has run a live end-to-end smoke test yet.** Nobody has connected a
  real Claude client to a running Jeeta server with a real `mk_live_…` key and
  watched a tool call complete. Every claim below about request/response shape
  comes from reading the source and from the unit/integration test suite
  (`backend/src/modules/marketing/mcp/**/*.spec.ts`, 18 suites / 84 tests, all
  passing as of this writing) — not from an observed live run. Do the steps in
  [Connect a client](#2-connect-a-client) yourself and check the two things
  listed there before trusting this in production.
- **Approving a queued request does not yet execute it.** See
  [Approval-gated tools](#approval-gated-tools) — this is a real, verified gap
  in the current code, not a hypothetical.

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
check **Read** and/or **Write**, create it, and copy the secret — it is shown
**exactly once**; only its SHA-256 hash is stored server-side
(`ApiKeysService.create`), so if you lose it you have to revoke and mint a new
one.

**Via the API**, with a valid OWNER/MANAGER marketing session token:

```bash
curl -sX POST http://localhost:3000/api/marketing/api-keys \
  -H "Authorization: Bearer <your marketing session JWT>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Claude MCP connector", "scopes": ["read", "write"]}'
```

Response includes `"key": "mk_live_…"` once. This is the bearer token the MCP
client uses — a different credential from the session JWT above.

`scopes` accepts **only** `"read"` and/or `"write"` today (enforced by
`CreateApiKeyDto`'s `@IsIn(['read', 'write'])`, and mirrored in the Settings UI
— see [Scopes](#scopes) for what those expand to, and why that currently makes
one tool unreachable).

## 2. Connect a client

```bash
claude mcp add --transport http jeeta http://localhost:3000/api/mcp \
  --header "Authorization: Bearer mk_live_XXXXXXXXXXXXXXXXXXXXXXXX"
```

Note the path: **`/api/mcp`**, not `/mcp`. `app.setGlobalPrefix('api')` in
`backend/src/app.config.ts` applies to the `@Controller('mcp')` route in
`backend/src/modules/marketing/mcp/mcp.controller.ts`, so the prefix stacks.

After adding, check two things:

1. **The tool list appears.** Ask Claude what Jeeta tools it has, or run
   whatever your client uses to list a server's tools. You should see a
   subset of (or all of, if the key has both `read` and `write`) the 18 tools
   in the [catalogue](#tool-catalogue) below. `McpServerFactoryService.build`
   filters the registry by the key's granted scopes per request, so a
   read-only key legitimately shows fewer tools, not an error.
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
`backend/src/modules/marketing/roles/permissions.ts`
(`leads.read`, `contacts.write`, `campaigns.send`, `settings.manage`, etc.).

Because API keys predate the MCP surface, they still carry only the coarse
`read` / `write` scopes shown in the Settings UI. `expandScopes()`
(`backend/src/modules/marketing/mcp/mcp-scopes.ts`) turns those into the
granular set an MCP tool actually checks:

| Raw key scope | Expands to |
|---|---|
| `read` | `leads.read`, `contacts.read`, `campaigns.read`, `reports.read`, `tasks.read` |
| `write` | everything `read` grants, **plus** `leads.write`, `contacts.write`, `tasks.write`, `campaigns.send` |

**`settings.manage` is not part of either expansion.** It's the scope
`jeeta.reallocate_budget` requires (real ad spend), and today neither the
Settings UI (`CreateApiKeyDialog.tsx`, hard-coded to `['read', 'write']`) nor
the `POST /api/marketing/api-keys` endpoint (`CreateApiKeyDto` validates
`@IsIn(['read', 'write'])`) can mint a key that carries it. `ApiKeysService.create`
itself accepts an arbitrary `scopes` array — it's only the controller/UI that
narrow it — so granting `settings.manage` to an MCP key currently requires
calling that service directly (e.g. a one-off script or a direct database
insert), not the normal key-management flow. Until that's wired up,
`jeeta.reallocate_budget` is effectively unreachable through the standard
setup.

## Tool catalogue

18 tools, registered in `backend/src/modules/marketing/mcp/tools/*.tools.ts`
and asserted by name in
`backend/src/modules/marketing/mcp/tools/tool-catalogue.spec.ts`. "Gated"
means the tool never runs inline in `APPROVAL` mode — see
[Approval-gated tools](#approval-gated-tools).

### Analytics

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.get_funnel` | Lead funnel counts per stage for a date range | `reports.read` | READ | No |

### Brand

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.search_brand_knowledge` | Free-text search over the workspace's Brand Brain (tone, positioning, products, policies), cited passages | `reports.read` | READ | No |

### Leads

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.search_leads` | Paginated lead search: text, status, source, city/region, priority, assignment, date range | `leads.read` | READ | No |

See [Lead search sees the whole workspace](#lead-search-sees-the-whole-workspace) —
this one does not narrow results by assignee the way a human REP's view does.

### Inbox

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.list_conversations` | List shared-inbox conversations, newest first | `contacts.read` | READ | No |
| `jeeta.read_conversation` | Full message history of one conversation + linked lead/channel | `contacts.read` | READ | No |
| `jeeta.send_message` | Reply in a conversation — reaches a real customer | `contacts.write` | WRITE | **Yes** (`SEND`) |

See [MCP replies are AI-authored](#mcp-replies-are-ai-authored) for how a sent
message is attributed.

### Campaigns

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.list_campaigns` | List campaigns with channel, status, last-known stats | `campaigns.read` | READ | No |
| `jeeta.get_campaign_performance` | Recipients, sent/failed/skipped, opened/clicked/unsubscribed, SMS rollup for one campaign | `reports.read` | READ | No |
| `jeeta.set_campaign_status` | Transition a campaign: `SENDING` (launch or resume), `PAUSED`, `CANCELLED` — reaches real customers | `campaigns.send` | WRITE | **Yes** (`PUBLISH`) |

### Social

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.list_scheduled_posts` | List social posts, newest first; defaults to `SCHEDULED`, `status` overrides | `campaigns.read` | READ | No |
| `jeeta.draft_social_post` | Create a `DRAFT` post (content + media + target accounts) — no external side effect until published | `campaigns.read` | WRITE | No |
| `jeeta.publish_social_post` | Publish a draft/scheduled post immediately to every attached account — reaches a real audience | `campaigns.send` | WRITE | **Yes** (`PUBLISH`) |

`jeeta.draft_social_post` is a WRITE-risk tool that is deliberately *not*
gated (it only creates an internal draft row), and its scope is
`campaigns.read` rather than a write scope — both are intentional per the
code comments, not oversights.

### Ads

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.get_ad_performance` | Aggregated spend/impressions/clicks/leads/revenue over a date range, totals + by-day + by-provider | `reports.read` | READ | No |
| `jeeta.get_budget` | Get (by id) or list the workspace's Growth Autopilot budget(s): amount, target ROAS/CAC, channel allocations | `reports.read` | READ | No |
| `jeeta.reallocate_budget` | Change a campaign/ad set's live daily budget on a connected ad account — spends real money | `settings.manage` | SPEND | **Yes** (`BUDGET_REALLOCATION`) |

### Scheduling

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.list_bookings` | List real bookings (not external busy blocks), filterable by calendar/status/time range | `tasks.read` | READ | No |
| `jeeta.get_booking_availability` | List bookable slot starts for a calendar + date range, honouring hours/buffers/notice/blackouts | `tasks.read` | READ | No |

There is no booking-creation tool — booking creation is a customer-facing
flow, not one wired into server-side MCP.

### Workspace

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.get_workspace_info` | Effective plan info: package, subscription status, quotas/limits, enabled features | `reports.read` | READ | No |

## Approval-gated tools

Four tools are risky enough (`SEND` / `PUBLISH` / `SPEND`) to be registered
`requiresApproval: true`: `jeeta.send_message`, `jeeta.set_campaign_status`,
`jeeta.publish_social_post`, `jeeta.reallocate_budget`.

When one of these is called and the workspace is in the default `APPROVAL`
write mode, `McpBrokerService.invoke` **never runs the tool's handler**. It
instead creates a row in `approval_requests`
(`kind` = the tool's `approvalKind`, `payload` = `{ tool, args }`,
`status = 'PENDING'`) and returns immediately. The MCP response back to the
model is not an error — it's a successful result whose text says explicitly:

> Queued for human approval (approvalId: …). It has NOT been applied yet.

(`McpServerFactoryService.handlerFor` — worded this way on purpose, so the
model doesn't report the action as done.)

A human with **OWNER/MANAGER** reviews the queue and decides:

```bash
# List pending requests (reports.read is enough to view)
GET /api/marketing/approvals

# Approve or reject one (settings.manage + MANAGER role required)
POST /api/marketing/approvals/:id/approve
POST /api/marketing/approvals/:id/reject
```

(`backend/src/modules/marketing/controllers/marketing-approvals.controller.ts`)

**Known gap: approving does not execute the action.** `approve()` only flips
the row's `status` to `APPROVED` and records who decided and when
(`ApprovalRequestService.decide`). Nothing then re-runs the original MCP tool
call. The only code that consumes an `APPROVED` `BUDGET_REALLOCATION` request
is `BudgetExecutorService.apply()` — but it expects a Growth-Autopilot-shaped
payload (`{ budgetId, after: [...] }`) and would reject an MCP-issued one
(`{ tool: 'jeeta.reallocate_budget', args: {...} }`) with "Approval payload
has no allocations." `SEND` and `PUBLISH` kinds have no executor at all. So
today, approving a queued `jeeta.send_message` / `jeeta.set_campaign_status` /
`jeeta.publish_social_post` / `jeeta.reallocate_budget` request records the
decision but does not send the message, change the campaign, publish the
post, or move the budget. Treat the approval queue as a **review/decision
log**, not yet a **do-it-now** button, until an executor is built for it.

## Write mode: APPROVAL vs AUTONOMOUS

`Workspace.mcpWriteMode` (Postgres column `workspaces."mcpWriteMode"`,
`TEXT NOT NULL DEFAULT 'APPROVAL'`) controls this per workspace. Read fresh on
every call (`McpInvokerService.writeModeFor`) — no caching, so a mode change
takes effect on the very next tool call, and any value other than the literal
string `'AUTONOMOUS'` behaves as `APPROVAL` (fail-safe default).

**What changes:** in `AUTONOMOUS` mode, the four gated tools listed above run
their handler **inline**, immediately, instead of enqueuing an approval —
`jeeta.send_message` sends the message right away, `jeeta.reallocate_budget`
pushes the live budget change right away, etc.

**What does not change:** every call — gated or not, in either mode — still
opens an `agent_runs` row first (see [Audit trail](#audit-trail)); the 32 KB
argument cap and scope check still apply; and a gated tool that runs inline in
`AUTONOMOUS` mode still writes its `tool_call_logs` row afterward, exactly as
an ungated tool does (verified by
`mcp-broker.writemode.spec.ts`: "still writes the audit log in AUTONOMOUS
mode"). The one thing that's different between the two modes for a gated tool
is precisely whether the handler runs before or only after a human clicks
approve (and, per the gap above, "after a human approves" doesn't currently
happen automatically either).

**There is currently no application surface (REST endpoint or UI) to flip
this switch.** It has to be set directly in the database:

```sql
UPDATE workspaces SET "mcpWriteMode" = 'AUTONOMOUS' WHERE id = '<workspace-id>';
-- revert:
UPDATE workspaces SET "mcpWriteMode" = 'APPROVAL' WHERE id = '<workspace-id>';
```

Given the executor gap above, switching a workspace to `AUTONOMOUS` is the
only way today to actually have `jeeta.send_message` / `jeeta.set_campaign_status`
/ `jeeta.publish_social_post` / `jeeta.reallocate_budget` do anything at all
— in `APPROVAL` mode they currently dead-end at the approval queue. Don't flip
this switch without understanding that trade-off.

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
approval in `APPROVAL` mode, the handler never runs, so **no
`tool_call_logs` row is written for that call** — only the `agent_runs` row
(whose `output` will show `{"status":"PENDING_APPROVAL","approvalId":"…"}`).

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
not that the call is still in flight.

## Known, deliberate properties

### Lead search sees the whole workspace

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
Task 8) as the correct behavior for the current API-key-only auth model. A
future OAuth-based connector (user-bound, not workspace-key-bound) is the
natural place to add per-user narrowing back in.

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
  commonly this is `jeeta.reallocate_budget` needing `settings.manage`, which
  no key minted through the normal flow currently carries.
- **A tool call comes back with `isError: true` and a message** instead of a
  thrown request failure — this is intentional
  (`McpServerFactoryService.handlerFor`): a scope refusal, an oversized
  argument payload, or an unknown tool name is surfaced as a structured tool
  result so the model can read the reason and adjust, rather than the whole
  MCP request failing.
- **A tool you expect isn't in the list** — check the key's scopes; the
  server only advertises tools the key's granted scopes fully satisfy
  (`McpToolRegistry.list`), so a caller can't even see the existence of a
  tool it can't call.
