# MCP Write-Surface Activation Plan (Faz 2.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the four approval-gated MCP tools actually work. Today they queue, a human approves, and nothing happens.

**Architecture:** Mirror the existing budget precedent — `BudgetExecutorService.apply(workspaceId, approvalId, userId)` called from a dedicated `@RequirePermission('settings.manage')` endpoint. A new `McpApprovalExecutorService` does the same for approval requests whose payload is an MCP `{tool, args}`: it re-invokes the tool through `McpBrokerService` with the approval gate explicitly satisfied, then `markApplied`. Plus the two reachability gaps: a way to set `Workspace.mcpWriteMode`, and a way to grant the granular scopes the tool catalogue actually declares.

**Tech Stack:** NestJS 11, Prisma, Jest, Zod.

## Global Constraints

- **The audit invariant is absolute.** Every executed tool call writes `agent_runs` + `tool_call_logs`, including calls executed via the approval path. An approval-applied call must be traceable to both the original MCP request and the approving user.
- **The approval gate may only be bypassed by an explicit, named signal** — never by silently reusing `writeMode: 'AUTONOMOUS'` in a way that makes an approved call indistinguishable from an autonomous one in the audit trail.
- **Applying an approval must be idempotent.** `markApplied` already claims `APPROVED → APPLIED` atomically; the executor must not be able to run the same tool twice.
- **A REJECTED or already-APPLIED request must never execute.**
- Scope strings use the existing dot vocabulary in `marketing/roles/permissions.ts`.
- Commit messages are plain conventional commits. No AI/Claude/Anthropic attribution, no `Co-Authored-By` trailer.
- Run `npx prisma generate` before believing any type error under `src/modules/marketing/strategy/**` — the local client goes stale.

---

## Task 1: Approval-execution context signal

**Files:**
- Modify: `backend/src/modules/marketing/mcp/mcp-tool-registry.ts`
- Modify: `backend/src/modules/marketing/mcp/mcp-broker.service.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-broker.approved.spec.ts`

**Interfaces:**
- Produces: `McpToolContext.approvedBy?: { approvalId: string; userId: string }`. When present, `invoke()` skips the approval-enqueue branch and executes, exactly as `AUTONOMOUS` does — but the field records *who* authorised it, so an approved execution is distinguishable from an autonomous one.

- [ ] **Step 1: Write the failing test**

Assert four behaviours: (a) a `requiresApproval` tool with `approvedBy` set executes inline rather than enqueuing; (b) it still writes the audit log; (c) `approvedBy` without `agentRunId` is still refused by the existing audit guard; (d) with neither `approvedBy` nor `AUTONOMOUS`, the tool still enqueues — the pre-existing behaviour.

- [ ] **Step 2: Run test, confirm it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-broker.approved.spec.ts`

- [ ] **Step 3: Add the field and widen the guard**

In `mcp-tool-registry.ts` add `approvedBy?: { approvalId: string; userId: string }` to `McpToolContext` with a comment stating it is set only by the approval executor.

In `mcp-broker.service.ts` change the single approval condition to also pass when `ctx.approvedBy` is set. Change nothing else — the policy order stays allow-list → audit guard → scope → arg-size → approval → execute+log.

- [ ] **Step 4: Run the whole mcp suite**

Run: `npm test -- src/modules/marketing/mcp/`
Expected: the new spec passes and every pre-existing spec still passes unedited.

- [ ] **Step 5: Commit**

---

## Task 2: The approval executor

**Files:**
- Create: `backend/src/modules/marketing/mcp/mcp-approval-executor.service.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-approval-executor.service.spec.ts`
- Modify: `backend/src/modules/marketing/marketing.module.ts`

**Interfaces:**
- Consumes: `ApprovalRequestService.markApplied(workspaceId, id)`; `McpBrokerService.invoke(ctx, toolName, args)`; `AgentRunService.track(...)`; Prisma for reading the `ApprovalRequest`.
- Produces: `McpApprovalExecutorService.apply(workspaceId: string, approvalId: string, userId: string): Promise<{ status: 'APPLIED'; result: unknown }>`.

**Behaviour:**
1. Load the `ApprovalRequest` scoped to `workspaceId`; 404 if missing or cross-workspace.
2. Reject anything whose `payload` is not an MCP `{ tool, args }` shape — a budget-autopilot approval must keep going through `BudgetExecutorService`, not this one.
3. Reject unless `status === 'APPROVED'`.
4. Open a fresh `AgentRun` (`agent: 'mcp'`, goal naming the tool and the approval) and invoke the broker with `approvedBy: { approvalId, userId }` plus `requireAudit: true`.
5. Call `markApplied` **after** a successful execution. Its atomic `APPROVED → APPLIED` claim is what prevents double execution — if it reports zero rows claimed, the request was already applied concurrently.
6. On tool failure, do **not** mark applied; surface the error so the operator can retry.

- [ ] **Step 1: Write the failing test**

Cover: the happy path executes and marks applied; a non-MCP payload is rejected; a `PENDING` request is rejected; a `REJECTED` request is rejected; a cross-workspace id 404s; a tool failure leaves the request un-applied; the executed call carries `approvedBy` into the broker context.

- [ ] **Step 2: Run test, confirm it fails**
- [ ] **Step 3: Implement the service**
- [ ] **Step 4: Register it in `marketing.module.ts`** (no separate module — `AgentRunService` carries a named `@Cron` and a second instance breaks boot)
- [ ] **Step 5: Run the whole mcp suite and `npm run build`**
- [ ] **Step 6: Commit**

---

## Task 3: The apply endpoint

**Files:**
- Modify: `backend/src/modules/marketing/controllers/marketing-approvals.controller.ts`
- Test: alongside the controller

**Interfaces:**
- Produces: `POST /api/marketing/approvals/:id/apply` → `McpApprovalExecutorService.apply(...)`.

Mirror `marketing-budget.controller.ts`'s `applyReallocation` exactly: `@RequirePermission('settings.manage')` and an `@Audit({ action: 'mcp.approval.apply', resourceType: 'approval_request', resourceIdParam: 'id' })` decorator.

Read the existing controller's guards and decorators first and match them — do not invent a different auth posture for this route.

- [ ] **Step 1: Write the failing test** — the route calls the executor with the caller's workspace and user id, and is refused without `settings.manage`.
- [ ] **Step 2: Run test, confirm it fails**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the suite and `npm run build`**
- [ ] **Step 5: Commit**

---

## Task 4: Make write mode settable

**Files:**
- Modify: `backend/src/modules/marketing/controllers/marketing-workspaces.controller.ts`
- Modify: the corresponding workspace service
- Test: alongside

**Interfaces:**
- Produces: an endpoint that sets `Workspace.mcpWriteMode` to `APPROVAL` or `AUTONOMOUS`, restricted to OWNER.

**This is the switch that lets a workspace opt out of the human gate, so it must be the most tightly guarded thing in this plan.** Requirements:
- OWNER only. Follow the repo's `@MarketingRoles` convention — list the floor, never co-list (co-listing means OWNER-only in this codebase; check `marketing-auth-rbac-gotchas` behaviour in the existing controllers before choosing).
- Audited via the `@Audit` decorator.
- Validate the value against exactly `['APPROVAL', 'AUTONOMOUS']` with a DTO; anything else is a 400.
- Read the current value back so an operator can confirm it.

- [ ] **Step 1: Write the failing test** — sets the value; rejects an unknown value; refuses a non-OWNER.
- [ ] **Step 2: Run test, confirm it fails**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the suite and `npm run build`**
- [ ] **Step 5: Commit**

---

## Task 5: Close the scope-reachability gaps

**Files:**
- Modify: `backend/src/modules/marketing/dto/api-key.dto.ts`
- Modify: `backend/src/modules/marketing/roles/permissions.ts`
- Modify: `backend/src/modules/marketing/mcp/tools/social.tools.ts`
- Modify: `frontend/src/.../CreateApiKeyDialog.tsx` (the scope list is hardcoded there)
- Tests: alongside each

Two gaps found in the final review of the previous phase:

1. **`jeeta.reallocate_budget` is unreachable.** It declares `settings.manage`, but `CreateApiKeyDto` restricts scopes to `@IsIn(['read','write'])` and `expandScopes` never yields `settings.manage`. Widen the DTO to accept the granular vocabulary so an operator can mint a key that reaches it. Keep `read`/`write` working as legacy shorthands.
2. **"May draft but not publish" is ungrantable.** `permissions.ts` has `campaigns.read` and `campaigns.send` but no `campaigns.write`, so `jeeta.draft_social_post` had to take `campaigns.send` — the same scope as publishing. Add `campaigns.write`, move `draft_social_post` onto it, and leave `publish_social_post` on `campaigns.send`.

**Do not widen the legacy `write` expansion** — that escalation was deliberately closed in the previous phase. Granular scopes must be granted explicitly.

- [ ] **Step 1: Write the failing tests** — a key minted with `settings.manage` reaches `reallocate_budget`; a key with `campaigns.write` reaches `draft_social_post` but NOT `publish_social_post`; legacy `read`/`write` still work and still do not reach send/publish.
- [ ] **Step 2: Run tests, confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the backend suite, the frontend suite, and `npm run build`**
- [ ] **Step 5: Commit**

---

## Task 6: Documentation refresh

**Files:**
- Modify: `docs/marketing/mcp-connector.md`

Update the operator guide to match reality after Tasks 1-5: the apply endpoint and how to use it, how to switch write mode, the new scopes and what each unlocks, and the corrected statement that gated tools now execute on approval. Remove the "write surface is inert" warning once it is no longer true, and remove the stale claim that `reallocate_budget` cannot be reached.

Derive every claim from the code, not from this plan.

- [ ] **Step 1: Rewrite the affected sections**
- [ ] **Step 2: Verify each claim against source**
- [ ] **Step 3: Commit**

---

## Task 7: Make MCP approvals actionable in the UI

**Files:**
- Modify: `frontend/src/features/marketing/api/growthBudget.service.ts`
- Modify: `frontend/src/pages/marketing/budget/BudgetAutopilotPage.tsx`
- Tests: alongside each

**This task is much smaller than it first appears.** The generic listing already exists: `BudgetAutopilotPage` calls `listPendingApprovals()` with no filter, so MCP approvals (`SEND`, `PUBLISH`, `BUDGET_REALLOCATION`) **already appear in that list today**. It branches on `r.kind` and currently sends `BUDGET_REALLOCATION` through `applyReallocation(id)` while every other kind gets `approveRequest(id)` alone — approve with no apply, which is precisely the gap Tasks 2-3 close on the backend.

So the work is:

1. Add `applyRequest(id)` to the API client, hitting the `POST /approvals/:id/apply` route from Task 3.
2. In the page's approve mutation, route MCP-originated kinds through approve-then-apply rather than approve alone. Determine "MCP-originated" from data the backend already returns — do not hardcode a kind list that will drift as tools are added. Inspect what `ApprovalRequest.payload` carries for an MCP request (the broker enqueues `{ tool, args }`) and prefer that over `kind`, which is shared with the budget autopilot.
3. Show the operator what they are approving: an MCP request's summary currently reads `MCP agent requested "<tool>"`. Surface the tool name and its arguments so nobody approves a customer message without seeing its text.
4. Keep `BUDGET_REALLOCATION` on its existing `applyReallocation` path — that flow is unchanged and must not regress.

**Discoverability is a real limitation, not a bug to fix here:** the queue lives on a budget-branded page. Note it in the docs; a dedicated approvals route is a separate decision.

- [ ] **Step 1: Write the failing tests** — an MCP-kind approval triggers approve then apply; a `BUDGET_REALLOCATION` still goes through `applyReallocation` and only that; the row renders the tool name and arguments.
- [ ] **Step 2: Run tests, confirm they fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the frontend suite**
- [ ] **Step 5: Commit**

---

## Task 8: Reclaim stranded APPLYING approvals

**Files:**
- Modify: `backend/src/modules/marketing/agents/approval-request.service.ts`
- Test: alongside

Task 2's claim-first state machine can leave a row in `APPLYING` if the revert itself throws or the process dies between claiming and finishing. Nothing reclaims it, so an approved action silently never happens and cannot be retried.

**The repo already solved this exact class of problem** — `AgentRunService.reapStaleRuns()` (`agents/agent-run.service.ts`) sweeps rows stranded in `RUNNING` on a 10-minute cron, with a staleness threshold and a warn log. Read it and mirror it rather than inventing a different shape.

Reclaim direction matters: a stranded `APPLYING` row should go back to **`APPROVED`**, not to `APPLIED`. The tool may or may not have run; returning it to the queue lets a human decide, whereas marking it applied would silently swallow an action that never happened. Say so in a comment, because the opposite choice looks equally plausible to a future reader.

Pick a threshold longer than any plausible tool round-trip and justify it in the report.

- [ ] **Step 1: Write the failing test** — a row stuck in `APPLYING` past the threshold is returned to `APPROVED`; a fresh `APPLYING` row is left alone; `APPLIED` and `REJECTED` rows are never touched.
- [ ] **Step 2: Run test, confirm it fails**
- [ ] **Step 3: Implement, mirroring `reapStaleRuns`**
- [ ] **Step 4: Run the mcp and budget suites**
- [ ] **Step 5: Commit**

---

## Out of scope, tracked separately

- A dedicated approvals route, separate from the budget page.
- `subscriptions/listen` holds a socket for no benefit until a Faz 4 event bus exists.
- The design spec's §4 `originValidation` / `hostHeaderValidation` never shipped.
