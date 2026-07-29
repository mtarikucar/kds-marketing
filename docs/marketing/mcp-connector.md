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
  real Claude client to a running Jeeta server with a real `mk_live_…` key,
  watched a tool call queue for approval, and watched a human approve **and**
  apply it. Every claim below about request/response shape and about the
  approve → apply → execute path comes from reading the source and from the
  unit/integration test suite (`backend/src/modules/marketing/mcp/**/*.spec.ts`
  plus `agents/approval-request.service.spec.ts`,
  `controllers/marketing-approvals.controller.spec.ts` and
  `controllers/marketing-workspaces.controller.spec.ts` — 27 suites / 176 tests,
  all passing as of this writing) — not from an observed live run. Do the
  steps in [Connect a client](#2-connect-a-client) yourself, and separately
  exercise the approval queue end to end (queue a write, approve it, apply
  it), before trusting this in production.
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
claude mcp add --transport http jeeta http://localhost:3000/api/mcp \
  --header "Authorization: Bearer mk_live_XXXXXXXXXXXXXXXXXXXXXXXX"
```

Note the path: **`/api/mcp`**, not `/mcp`. `app.setGlobalPrefix('api')` in
`backend/src/app.config.ts` applies to the `@Controller('mcp')` route in
`backend/src/modules/marketing/mcp/mcp.controller.ts`, so the prefix stacks.

After adding, check two things:

1. **The tool list appears.** Ask Claude what Jeeta tools it has, or run
   whatever your client uses to list a server's tools. You should see the
   tools among the 18 in the [catalogue](#tool-catalogue) below whose scope
   the key's granted scopes cover — for a legacy `read` or `write` key
   (see [Scopes](#scopes) for why the two are equivalent here) that's the 13
   read-only tools, not all 18; the 5 write-risk tools need a granular scope
   minted explicitly. `McpServerFactoryService.build` filters the registry by
   the key's granted scopes per request, so a narrower key legitimately shows
   fewer tools, not an error.
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

An API key's `scopes` array can now hold **either** the legacy `read`/`write`
shorthands **or** any of those granular permission strings directly, or a mix
of both (`CreateApiKeyDto`'s `@IsIn(['read', 'write', ...PERMISSIONS])`).
`expandScopes()` (`backend/src/modules/marketing/mcp/mcp-scopes.ts`) is what
turns a key's raw `scopes` into the granted set an MCP tool call is actually
checked against, on every request (no caching — see
[Endpoint reference](#endpoint-reference)):

| Raw key scope | Expands to |
|---|---|
| `read` | `leads.read`, `contacts.read`, `campaigns.read`, `reports.read`, `tasks.read` |
| `write` | everything `read` grants, **plus** `leads.write`, `tasks.write` — **nothing else** |
| any granular string (e.g. `settings.manage`, `campaigns.write`, `contacts.write`, `campaigns.send`) | passed through untouched |

**This is deliberate and load-bearing, and it means less than it sounds
like.** Of the 18 MCP tools, **none** require `leads.write` or `tasks.write` —
so today, a key minted with only the legacy `write` shorthand reaches exactly
the same set of MCP tools as a `read`-only key: every read tool, and nothing
more. It reaches **none** of the write-risk tools — the four approval-gated
ones or `jeeta.draft_social_post` — because each of them requires a granular
scope the legacy `write` expansion does not include:

| Tool | Requires | In legacy `write`? |
|---|---|---|
| `jeeta.send_message` | `contacts.write` | No |
| `jeeta.set_campaign_status` | `campaigns.send` | No |
| `jeeta.publish_social_post` | `campaigns.send` | No |
| `jeeta.reallocate_budget` | `settings.manage` | No |
| `jeeta.draft_social_post` | `campaigns.write` | No (ungated, but still needs the granular scope minted explicitly) |

This split is intentional (`mcp-scopes.ts` doc comment, `mcp-scopes.spec.ts`):
over the REST API a coarse `write` key only ever touched leads, and MCP
shouldn't silently widen that into "can message customers / publish content /
spend ad budget" just because a key predates the granular vocabulary. To reach
any of the tools above, mint a key (or add scopes to an existing one) that
carries the specific granular permission — via the Settings UI's **Granular
scopes** checklist, or by passing the string directly in the API's `scopes`
array (e.g. `{"scopes": ["read", "settings.manage"]}` for a key that can call
`jeeta.reallocate_budget`). `jeeta.reallocate_budget` in particular is now
reachable through the standard key-management flow — it no longer requires
calling `ApiKeysService` directly or writing to the database.

## Tool catalogue

18 tools, registered in `backend/src/modules/marketing/mcp/tools/*.tools.ts`
and asserted by name in
`backend/src/modules/marketing/mcp/tools/tool-catalogue.spec.ts`. "Gated"
means the tool never runs inline in `APPROVAL` mode — see
[Approval-gated tools](#approval-gated-tools).

**Argument names are exact.** Every tool's schema is registered strict
(`McpToolRegistry.register`), so an argument the tool does not declare is an
error — `Unrecognized key: "query"` — rather than something quietly ignored.
This matters most on optional filters: dropping one silently would widen the
result set, and a search that answers with everything looks to an agent like a
search that matched everything. Read the parameter names off `tools/list`,
which advertises `additionalProperties: false` for the same reason.

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
| `jeeta.draft_social_post` | Create a `DRAFT` post (content + media + target accounts) — no external side effect until published | `campaigns.write` | WRITE | No |
| `jeeta.publish_social_post` | Publish a draft/scheduled post immediately to every attached account — reaches a real audience | `campaigns.send` | WRITE | **Yes** (`PUBLISH`) |

`jeeta.draft_social_post` is a WRITE-risk tool that is deliberately *not*
gated (it only creates an internal draft row), and its scope is `campaigns.write`
rather than `campaigns.send` — a caller allowed to prepare content is not
automatically trusted to publish it. Both are intentional per the code
comments (`social.tools.ts`), not oversights.

### Ads

| Tool | What it does | Scope | Risk | Gated |
|---|---|---|---|---|
| `jeeta.get_ad_performance` | Aggregated spend/impressions/clicks/leads/revenue over a date range, totals + by-day + by-provider | `reports.read` | READ | No |
| `jeeta.get_budget` | Get (by id) or list the workspace's Growth Autopilot budget(s): amount, target ROAS/CAC, channel allocations | `reports.read` | READ | No |
| `jeeta.reallocate_budget` | Change a campaign/ad set's live daily budget on a connected ad account — spends real money | `settings.manage` | SPEND | **Yes** (`BUDGET_REALLOCATION`) |

`jeeta.reallocate_budget` shares its `BUDGET_REALLOCATION` approval `kind`
with the Growth Autopilot's own reallocation proposals — the two are told
apart by payload shape (MCP's `{ tool, args }` vs. Autopilot's
`{ budgetId, after: [...] }`) wherever they meet; see
[Approval-gated tools](#approval-gated-tools).

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
2. It re-invokes the original tool (`jeeta.send_message`,
   `jeeta.set_campaign_status`, `jeeta.publish_social_post` or
   `jeeta.reallocate_budget`) through `McpBrokerService.invoke`, with
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
`jeeta.set_campaign_status` genuinely transitions the campaign,
`jeeta.publish_social_post` genuinely publishes, and `jeeta.reallocate_budget`
genuinely pushes the live budget change — but only after **both** calls, not
after approve alone.

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

**What changes:** in `AUTONOMOUS` mode, the four gated tools run their handler
**inline, immediately, with no human in the loop** — `jeeta.send_message`
sends the message right away, `jeeta.set_campaign_status` transitions the
campaign right away, `jeeta.publish_social_post` publishes right away,
`jeeta.reallocate_budget` pushes the live budget change right away. Nothing
is queued and there is nothing to approve or apply — the model's tool call
*is* the action. Read [Approval-gated tools](#approval-gated-tools) first so
you know exactly what those four tools can do before turning this on for a
workspace.

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
make), treat it accordingly: confirm you understand the four gated tools'
behavior in [Approval-gated tools](#approval-gated-tools) before setting a
production workspace to `AUTONOMOUS`.

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
  commonly this is a key minted with only the legacy `write` shorthand trying
  to call `jeeta.send_message`, `jeeta.set_campaign_status`,
  `jeeta.publish_social_post`, `jeeta.draft_social_post`, or
  `jeeta.reallocate_budget` — `write` does not expand into any of the
  `contacts.write` / `campaigns.send` / `campaigns.write` / `settings.manage`
  scopes those tools need. Mint (or add to) a key with the specific granular
  scope instead.
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
- **`POST /approvals/:id/apply` returns `400 cannot apply a <STATUS> request`**
  — `apply` only accepts a row currently `APPROVED`. `PENDING` means nobody
  has approved it yet (approve first); `APPLIED`/`REJECTED`/`EXPIRED` are
  terminal; `APPLYING` means another `apply` call is already in flight for
  this request right now (wait for it, or for the reaper to reclaim it if it
  crashed — see [Approval-gated tools](#approval-gated-tools)).
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
