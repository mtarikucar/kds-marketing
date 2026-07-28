# MCP Connector (Faz 1–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Jeeta as a remote MCP server at `POST /api/mcp` so Claude Code can authenticate with an existing `mk_live_…` API key and drive a curated, audited, scope-checked tool surface.

**Architecture:** A new `McpModule` mounts the MCP Streamable-HTTP handler inside the existing NestJS app. `requireBearerAuth` verifies the bearer token via a custom `OAuthTokenVerifier` backed by `ApiKeysService`, producing an `AuthInfo`. A per-request `McpServerFactory` turns that `AuthInfo` into an `McpToolContext` and registers tools whose handlers all funnel through **one** invoker, which wraps every call in `AgentRunService.track()` (guaranteeing an audit row) and then delegates to the **existing, unmodified** `McpBrokerService` for allow-list, scope, approval-gating and `ToolCallLog` writes. Faz 2 adds a per-workspace write mode and expands the tool catalogue.

**Tech Stack:** NestJS 11, Express 5, Prisma, Jest, TypeScript 5.3, `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/express@2.0.0`, Zod.

## Global Constraints

- **Never modify `McpBrokerService`'s existing policy order** (allow-list → scope → approval → arg-size → execute+log). Task 9 adds exactly one branch; nothing else in that file changes.
- **The existing `mcp-broker.service.spec.ts` must keep passing unchanged** after every task.
- **Scope strings use the existing dot vocabulary** from `marketing/roles/permissions.ts` — `leads.read`, `leads.write`, `leads.manage`, `campaigns.read`, `campaigns.send`, `contacts.read`, `contacts.write`, `reports.read`, `tasks.read`, `tasks.write`, `settings.manage`, `automations.manage`, `billing.manage`, `users.manage`, `courses.manage`, `role.*`. **Never invent colon-style scopes** (`leads:write`) — the design spec's §5.3 used colons; the codebase uses dots and the codebase wins.
- **Tool names are dot-prefixed with `jeeta.`** — e.g. `jeeta.get_campaign_performance` — matching the names already used in `mcp-broker.service.spec.ts`.
- **`AuthInfo.expiresAt` must always be populated.** The SDK's bearer-auth helper *rejects tokens whose `expiresAt` is unset*. `mk_live_…` keys never expire, so the verifier must synthesise a sliding value.
- **Every tool MUST declare an `inputSchema`, and the factory MUST pass it to `registerTool`.** This is not a nicety — it is a correctness and security requirement. The SDK's `createToolExecutor` (`@modelcontextprotocol/server@2.0.0`, `dist/mcp-*.mjs`) reads:

  ```js
  function createToolExecutor(inputSchema, handler) {
    if (inputSchema) return async (args, ctx) => callback$1(args, ctx);
    return async (_args, ctx) => callback(ctx);   // no schema → WRONG ARITY
  }
  ```

  With no `inputSchema` the handler's first parameter is the SDK's `ServerContext`, not the caller's arguments. Two consequences: every tool call silently loses its real arguments, **and** `ServerContext` carries `http.authInfo` — the caller's bearer token — which would flow into `broker.invoke(…, args)` → `recordTool` → the `ToolCallLog.args` JSON column, writing a live credential into the audit database. Schemas are Zod (`zod@4.4.3`, already a production dependency; the SDK accepts Standard Schema).
- **Every migration ships an `up` + a `down.sql`** and the up→down→up round-trip must be verified (project convention; global rule).
- **No AI/Claude attribution in commit messages.** Plain conventional commits.
- Run backend tests with `npm test -- <path>` from `backend/`.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/modules/marketing/mcp/mcp-token-verifier.service.ts` | **Create.** Implements `OAuthTokenVerifier`; `mk_live_…` → `AuthInfo`. Sole place a raw token becomes an identity. |
| `backend/src/modules/marketing/mcp/mcp-scopes.ts` | **Create.** Pure functions: expand legacy `read`/`write` into the dot vocabulary; no I/O. |
| `backend/src/modules/marketing/mcp/mcp-invoker.service.ts` | **Create.** The single call path: `AuthInfo` → `McpToolContext`, wraps `AgentRunService.track()`, delegates to broker. Guarantees an audit row exists. |
| `backend/src/modules/marketing/mcp/mcp-server.factory.ts` | **Create.** Per-request `McpServer`; registers every tool from the registry, each handler calling the invoker. |
| `backend/src/modules/marketing/mcp/mcp.controller.ts` | **Create.** `POST /api/mcp`; runs bearer auth, hands the request to the MCP handler. |
| `backend/src/modules/marketing/marketing.module.ts` | **Modify (Task 7).** Registers `McpController` and the new MCP providers. **No separate `mcp.module.ts`** — the broker, registry, `AgentRunService` and friends already live here, and re-providing a `@Cron`-bearing service in a second module breaks boot. |
| `backend/src/modules/marketing/mcp/tools/*.tools.ts` | **Create.** One file per vertical; each exports a `register…Tools(registry, deps)` function. |
| `backend/src/modules/marketing/mcp/mcp-tool-registry.ts` | **Unchanged.** |
| `backend/src/modules/marketing/mcp/mcp-broker.service.ts` | **Modify (Task 4, Task 9 only).** Audit guard + write-mode branch. |
| `backend/prisma/schema.prisma` | **Modify (Task 8).** `Workspace.mcpWriteMode`. |

---

### Task 1: Scope expansion helper

**Files:**
- Create: `backend/src/modules/marketing/mcp/mcp-scopes.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-scopes.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `expandScopes(raw: string[]): string[]` — expands legacy `'read'` / `'write'` into the dot vocabulary and passes through already-granular scopes. `MCP_READ_SCOPES: readonly string[]`, `MCP_WRITE_SCOPES: readonly string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp-scopes.spec.ts
import { expandScopes, MCP_READ_SCOPES, MCP_WRITE_SCOPES } from './mcp-scopes';

describe('expandScopes', () => {
  it('expands legacy "read" into every read scope', () => {
    const out = expandScopes(['read']);
    for (const s of MCP_READ_SCOPES) expect(out).toContain(s);
    expect(out).not.toContain('leads.write');
  });

  it('expands legacy "write" into read + write scopes', () => {
    const out = expandScopes(['write']);
    expect(out).toContain('leads.write');
    expect(out).toContain('leads.read');
  });

  it('passes granular scopes through untouched', () => {
    expect(expandScopes(['reports.read'])).toEqual(['reports.read']);
  });

  it('de-duplicates when legacy and granular overlap', () => {
    const out = expandScopes(['read', 'reports.read']);
    expect(out.filter((s) => s === 'reports.read')).toHaveLength(1);
  });

  it('returns an empty array for no input', () => {
    expect(expandScopes([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-scopes.spec.ts`
Expected: FAIL — `Cannot find module './mcp-scopes'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/modules/marketing/mcp/mcp-scopes.ts

/**
 * The granular permission vocabulary the MCP tool surface uses. These strings
 * are the ones already defined in `marketing/roles/permissions.ts` — MCP does
 * NOT introduce a parallel vocabulary.
 */
export const MCP_READ_SCOPES = [
  'leads.read',
  'contacts.read',
  'campaigns.read',
  'reports.read',
  'tasks.read',
] as const;

export const MCP_WRITE_SCOPES = [
  'leads.write',
  'contacts.write',
  'tasks.write',
  'campaigns.send',
] as const;

/**
 * API keys minted before the MCP surface existed carry only the coarse
 * `read`/`write` scopes (see ApiKeysService). Expand those into the granular
 * vocabulary so existing keys keep working, and pass granular scopes through
 * untouched.
 */
export function expandScopes(raw: string[]): string[] {
  const out = new Set<string>();
  for (const scope of raw) {
    if (scope === 'read') {
      MCP_READ_SCOPES.forEach((s) => out.add(s));
    } else if (scope === 'write') {
      MCP_READ_SCOPES.forEach((s) => out.add(s));
      MCP_WRITE_SCOPES.forEach((s) => out.add(s));
    } else {
      out.add(scope);
    }
  }
  return [...out];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/marketing/mcp/mcp-scopes.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/marketing/mcp/mcp-scopes.ts src/modules/marketing/mcp/mcp-scopes.spec.ts
git commit -m "feat(mcp): add scope expansion for legacy read/write API keys"
```

---

### Task 2: Bearer token verifier

**Files:**
- Create: `backend/src/modules/marketing/mcp/mcp-token-verifier.service.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-token-verifier.service.spec.ts`

**Interfaces:**
- Consumes: `expandScopes` (Task 1); `ApiKeysService.authenticate(raw: string): Promise<ApiAuth | null>` where `ApiAuth = { apiKeyId: string; workspaceId: string; scopes: string[] }`.
- Produces: `McpTokenVerifierService` implementing `verifyAccessToken(token: string): Promise<AuthInfo>`. It sets `AuthInfo.extra = { workspaceId, apiKeyId }` so downstream code can recover the tenant.

**Why `expiresAt` matters:** the SDK's bearer-auth helper rejects any `AuthInfo` without `expiresAt`. API keys do not expire, so we emit a rolling one-hour value. This is a protocol requirement, not a security boundary — revocation is still enforced by `ApiKeysService.authenticate` on every request.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp-token-verifier.service.spec.ts
import { McpTokenVerifierService } from './mcp-token-verifier.service';

function deps(auth: unknown) {
  const authenticate = jest.fn().mockResolvedValue(auth);
  const apiKeys = { authenticate } as any;
  return { verifier: new McpTokenVerifierService(apiKeys), authenticate };
}

describe('McpTokenVerifierService', () => {
  it('resolves a valid key to AuthInfo carrying the workspace', async () => {
    const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] });
    const info = await verifier.verifyAccessToken('mk_live_abc');
    expect(info.extra).toMatchObject({ workspaceId: 'ws1', apiKeyId: 'k1' });
    expect(info.clientId).toBe('k1');
    expect(info.token).toBe('mk_live_abc');
  });

  it('always populates expiresAt (the SDK rejects tokens without it)', async () => {
    const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] });
    const info = await verifier.verifyAccessToken('mk_live_abc');
    expect(typeof info.expiresAt).toBe('number');
    expect(info.expiresAt!).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('expands legacy scopes onto the AuthInfo', async () => {
    const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] });
    const info = await verifier.verifyAccessToken('mk_live_abc');
    expect(info.scopes).toContain('reports.read');
  });

  it('throws for an unknown or revoked key', async () => {
    const { verifier } = deps(null);
    await expect(verifier.verifyAccessToken('mk_live_nope')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-token-verifier.service.spec.ts`
Expected: FAIL — `Cannot find module './mcp-token-verifier.service'`

- [ ] **Step 3: Install the SDK packages**

```bash
cd backend && npm install @modelcontextprotocol/server@2 @modelcontextprotocol/express@2
```

If npm fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, the environment intercepts TLS — re-run as `NODE_OPTIONS=--use-system-ca npm install @modelcontextprotocol/server@2 @modelcontextprotocol/express@2`.

- [ ] **Step 4: Write minimal implementation**

```ts
// backend/src/modules/marketing/mcp/mcp-token-verifier.service.ts
import { Injectable } from '@nestjs/common';
import { AuthInfo, OAuthError, OAuthErrorCode, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { ApiKeysService } from '../services/api-keys.service';
import { expandScopes } from './mcp-scopes';

/** API keys do not expire; the SDK still requires an expiry, so we roll one. */
const SYNTHETIC_TTL_SECONDS = 60 * 60;

/**
 * Turns an `Authorization: Bearer mk_live_…` header into an MCP `AuthInfo`.
 * This is the ONLY place a raw token becomes an identity on the MCP surface.
 * Revocation is enforced on every request because `authenticate()` hits the
 * database each time — the synthetic `expiresAt` is a protocol formality, not
 * a cache.
 */
@Injectable()
export class McpTokenVerifierService implements OAuthTokenVerifier {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const auth = await this.apiKeys.authenticate(token);
    if (!auth) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or revoked API key');
    }
    return {
      token,
      clientId: auth.apiKeyId,
      scopes: expandScopes(auth.scopes ?? []),
      expiresAt: Math.floor(Date.now() / 1000) + SYNTHETIC_TTL_SECONDS,
      extra: { workspaceId: auth.workspaceId, apiKeyId: auth.apiKeyId },
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/marketing/mcp/mcp-token-verifier.service.spec.ts`
Expected: PASS (4 tests)

If TypeScript rejects `extra`, check the installed `AuthInfo` declaration:
`grep -A30 "^interface AuthInfo" node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`
and use whatever pass-through field it declares. Do not cast to `any` — the field name must be correct because Task 3 reads it back.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/marketing/mcp/mcp-token-verifier.service.ts src/modules/marketing/mcp/mcp-token-verifier.service.spec.ts
git commit -m "feat(mcp): verify mk_live API keys as MCP bearer tokens"
```

---

### Task 3: Audited invoker

**Files:**
- Create: `backend/src/modules/marketing/mcp/mcp-invoker.service.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-invoker.service.spec.ts`

**Interfaces:**
- Consumes: `AgentRunService.track<T>(workspaceId, { agent, goal, input }, fn: (runId: string) => Promise<T>): Promise<T>`; `McpBrokerService.invoke(ctx, toolName, args): Promise<InvokeResult>` where `InvokeResult = { status: 'OK' | 'PENDING_APPROVAL'; result?: unknown; approvalId?: string }`.
- Produces: `McpInvokerService.invoke(authInfo: AuthInfo, toolName: string, args: Record<string, unknown>): Promise<InvokeResult>` and `McpInvokerService.contextFrom(authInfo: AuthInfo): { workspaceId: string; grantedScopes: string[] }`.

**Why this exists:** `McpBrokerService.log()` early-returns when `ctx.agentRunId` is unset, so a tool call made without a run writes **no** `ToolCallLog`. Routing every MCP call through `track()` makes an `AgentRun` exist before the broker is ever reached.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp-invoker.service.spec.ts
import { McpInvokerService } from './mcp-invoker.service';
import type { AuthInfo } from '@modelcontextprotocol/server';

const authInfo = (workspaceId: string | undefined, scopes: string[] = ['reports.read']): AuthInfo =>
  ({
    token: 't',
    clientId: 'k1',
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    extra: workspaceId ? { workspaceId, apiKeyId: 'k1' } : {},
  }) as AuthInfo;

function deps() {
  const invoke = jest.fn().mockResolvedValue({ status: 'OK', result: { ok: 1 } });
  const track = jest.fn(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => fn('run-1'));
  const invoker = new McpInvokerService({ invoke } as any, { track } as any);
  return { invoker, invoke, track };
}

describe('McpInvokerService', () => {
  it('opens an AgentRun and passes its id to the broker', async () => {
    const { invoker, invoke, track } = deps();
    await invoker.invoke(authInfo('ws1'), 'jeeta.get_funnel', { days: 7 });
    expect(track).toHaveBeenCalledWith('ws1', expect.objectContaining({ agent: 'mcp', goal: 'jeeta.get_funnel' }), expect.any(Function));
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', agentRunId: 'run-1' }),
      'jeeta.get_funnel',
      { days: 7 },
    );
  });

  it('forwards the granted scopes to the broker context', async () => {
    const { invoker, invoke } = deps();
    await invoker.invoke(authInfo('ws1', ['leads.read']), 'jeeta.search_leads', {});
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ grantedScopes: ['leads.read'] }), 'jeeta.search_leads', {});
  });

  it('returns the broker result unchanged', async () => {
    const { invoker } = deps();
    await expect(invoker.invoke(authInfo('ws1'), 'jeeta.get_funnel', {})).resolves.toEqual({ status: 'OK', result: { ok: 1 } });
  });

  it('refuses to invoke when the token carries no workspace', async () => {
    const { invoker, invoke } = deps();
    await expect(invoker.invoke(authInfo(undefined), 'jeeta.get_funnel', {})).rejects.toThrow(/workspace/i);
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-invoker.service.spec.ts`
Expected: FAIL — `Cannot find module './mcp-invoker.service'`

- [ ] **Step 3: Add `requireAudit` to the tool context**

The invoker sets this flag; Task 4 makes the broker act on it. Adding the field here keeps this task compiling on its own. In `mcp-tool-registry.ts`, extend `McpToolContext`:

```ts
  /**
   * Set by callers that MUST be auditable (the MCP transport). When true, a
   * call without `agentRunId` is refused rather than executed unlogged.
   */
  requireAudit?: boolean;
```

- [ ] **Step 4: Write minimal implementation**

```ts
// backend/src/modules/marketing/mcp/mcp-invoker.service.ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { AgentRunService } from '../agents/agent-run.service';
import { InvokeResult, McpBrokerService } from './mcp-broker.service';

/**
 * The single call path for every MCP tool invocation.
 *
 * Its whole job is to make the audit trail unskippable: `McpBrokerService.log()`
 * silently writes nothing when `ctx.agentRunId` is absent, so we open an
 * AgentRun via `track()` FIRST and only then reach the broker. A tool call that
 * cannot be attributed to a run never executes.
 */
@Injectable()
export class McpInvokerService {
  constructor(
    private readonly broker: McpBrokerService,
    private readonly runs: AgentRunService,
  ) {}

  contextFrom(authInfo: AuthInfo): { workspaceId: string; grantedScopes: string[] } {
    const workspaceId = (authInfo.extra as { workspaceId?: string } | undefined)?.workspaceId;
    if (!workspaceId) {
      throw new ForbiddenException('token is not bound to a workspace');
    }
    return { workspaceId, grantedScopes: authInfo.scopes ?? [] };
  }

  async invoke(authInfo: AuthInfo, toolName: string, args: Record<string, unknown>): Promise<InvokeResult> {
    const { workspaceId, grantedScopes } = this.contextFrom(authInfo);
    return this.runs.track(workspaceId, { agent: 'mcp', goal: toolName, input: args }, (agentRunId) =>
      this.broker.invoke({ workspaceId, grantedScopes, agentRunId, requireAudit: true }, toolName, args),
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/marketing/mcp/mcp-invoker.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Confirm the existing broker spec still passes**

Run: `npm test -- src/modules/marketing/mcp/mcp-broker.service.spec.ts`
Expected: PASS — adding an optional field to `McpToolContext` changes no behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/modules/marketing/mcp/mcp-invoker.service.ts src/modules/marketing/mcp/mcp-invoker.service.spec.ts src/modules/marketing/mcp/mcp-tool-registry.ts
git commit -m "feat(mcp): route tool calls through an audited invoker"
```

---

### Task 4: Make the audit requirement enforceable in the broker

**Files:**
- Modify: `backend/src/modules/marketing/mcp/mcp-tool-registry.ts` (the `McpToolContext` interface)
- Modify: `backend/src/modules/marketing/mcp/mcp-broker.service.ts` (`invoke` entry)
- Test: `backend/src/modules/marketing/mcp/mcp-broker.audit.spec.ts`

**Interfaces:**
- Consumes: `McpToolContext.requireAudit?: boolean` (added in Task 3).
- Produces: `McpBrokerService.invoke()` throws `ForbiddenException` when `requireAudit` is `true` and `agentRunId` is unset. When `requireAudit` is unset, behaviour is exactly as today — this is why the existing broker spec keeps passing.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp-broker.audit.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const approvals = { enqueue: jest.fn().mockResolvedValue({ id: 'appr-1' }) } as any;
  const runs = { recordTool: jest.fn().mockResolvedValue(undefined) } as any;
  return { registry, broker: new McpBrokerService(registry, approvals, runs), runs };
}

const tool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.get_funnel',
  description: 'read funnel',
  scopes: ['reports.read'],
  risk: 'READ',
  requiresApproval: false,
  handler,
});

describe('McpBrokerService audit enforcement', () => {
  it('rejects an auditable call that carries no agentRunId', async () => {
    const { registry, broker } = deps();
    const handler = jest.fn();
    registry.register(tool(handler));
    await expect(
      broker.invoke({ workspaceId: 'ws1', grantedScopes: ['reports.read'], requireAudit: true }, 'jeeta.get_funnel'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes and logs when an agentRunId is present', async () => {
    const { registry, broker, runs } = deps();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(tool(handler));
    const res = await broker.invoke(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'], agentRunId: 'run-1', requireAudit: true },
      'jeeta.get_funnel',
    );
    expect(res).toEqual({ status: 'OK', result: { ok: true } });
    expect(runs.recordTool).toHaveBeenCalled();
  });

  it('leaves non-auditable callers untouched (back-compat)', async () => {
    const { registry, broker } = deps();
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registry.register(tool(handler));
    await expect(
      broker.invoke({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, 'jeeta.get_funnel'),
    ).resolves.toEqual({ status: 'OK', result: { ok: true } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-broker.audit.spec.ts`
Expected: FAIL — the first test resolves instead of rejecting.

- [ ] **Step 3: Add the guard to the broker**

In `mcp-broker.service.ts`, inside `invoke()`, immediately **after** the existing `if (!tool) throw new NotFoundException(...)` line and **before** `this.assertScopes(...)`:

```ts
    if (ctx.requireAudit && !ctx.agentRunId) {
      throw new ForbiddenException('audit context required: no agentRunId');
    }
```

- [ ] **Step 4: Run both broker specs**

Run: `npm test -- src/modules/marketing/mcp/`
Expected: PASS — the new audit spec (3 tests) **and** the pre-existing `mcp-broker.service.spec.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/modules/marketing/mcp/
git commit -m "feat(mcp): refuse auditable tool calls that carry no agent run"
```

---

### Task 5: First read tool + tool module pattern

**Files:**
- Create: `backend/src/modules/marketing/mcp/tools/analytics.tools.ts`
- Test: `backend/src/modules/marketing/mcp/tools/analytics.tools.spec.ts`

**Interfaces:**
- Consumes: `McpToolRegistry.register(tool: McpTool)`; `AnalyticsService.funnel(workspaceId: string, r: DateRange)` where `DateRange` is the type already exported by `analytics/analytics.service.ts`.
- Produces: `registerAnalyticsTools(registry: McpToolRegistry, deps: { analytics: AnalyticsService }): void`, registering `jeeta.get_funnel`. **This is the pattern every later tool file copies:** a `register…Tools(registry, deps)` free function, tools declared with explicit `scopes`/`risk`/`requiresApproval`, handler pulling `workspaceId` off the context.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/tools/analytics.tools.spec.ts
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerAnalyticsTools } from './analytics.tools';

describe('analytics MCP tools', () => {
  it('registers jeeta.get_funnel as a READ tool needing reports.read', () => {
    const registry = new McpToolRegistry();
    registerAnalyticsTools(registry, { analytics: { funnel: jest.fn() } as any });
    const tool = registry.get('jeeta.get_funnel');
    expect(tool).toBeDefined();
    expect(tool!.risk).toBe('READ');
    expect(tool!.requiresApproval).toBe(false);
    expect(tool!.scopes).toEqual(['reports.read']);
  });

  it('calls the analytics service with the context workspace', async () => {
    const registry = new McpToolRegistry();
    const funnel = jest.fn().mockResolvedValue({ stages: [] });
    registerAnalyticsTools(registry, { analytics: { funnel } as any });
    const tool = registry.get('jeeta.get_funnel')!;
    const out = await tool.handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, { from: '2026-07-01', to: '2026-07-28' });
    expect(funnel).toHaveBeenCalledWith('ws1', { from: '2026-07-01', to: '2026-07-28' });
    expect(out).toEqual({ stages: [] });
  });

  it('is hidden from a caller lacking reports.read', () => {
    const registry = new McpToolRegistry();
    registerAnalyticsTools(registry, { analytics: { funnel: jest.fn() } as any });
    expect(registry.list(['leads.read']).map((t) => t.name)).not.toContain('jeeta.get_funnel');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/tools/analytics.tools.spec.ts`
Expected: FAIL — `Cannot find module './analytics.tools'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/modules/marketing/mcp/tools/analytics.tools.ts
import { z } from 'zod';
import { AnalyticsService, type DateRange } from '../../analytics/analytics.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface AnalyticsToolDeps {
  analytics: AnalyticsService;
}

/**
 * Analytics tools are pure reads over workspace-scoped aggregates, so they need
 * no approval gate and no user principal — `workspaceId` alone is sufficient
 * tenancy.
 */
export function registerAnalyticsTools(registry: McpToolRegistry, deps: AnalyticsToolDeps): void {
  registry.register({
    name: 'jeeta.get_funnel',
    description:
      'Get the lead funnel for a date range: counts per stage from first touch to won. Use for "how is the pipeline doing" questions.',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      from: z.string().optional().describe('Inclusive start date, ISO 8601 (YYYY-MM-DD).'),
      to: z.string().optional().describe('Inclusive end date, ISO 8601 (YYYY-MM-DD).'),
    }),
    handler: async (ctx, args) => {
      const range: DateRange = {};
      if (typeof args.from === 'string') range.from = args.from;
      if (typeof args.to === 'string') range.to = args.to;
      return deps.analytics.funnel(ctx.workspaceId, range);
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/marketing/mcp/tools/analytics.tools.spec.ts`
Expected: PASS (3 tests)

If `DateRange` is exported from `analytics.service.ts`, import it and replace `as never` with that type. Check with:
`grep -n "DateRange" src/modules/marketing/analytics/analytics.service.ts`

- [ ] **Step 5: Commit**

```bash
git add src/modules/marketing/mcp/tools/
git commit -m "feat(mcp): add analytics funnel tool and the tool-module pattern"
```

---

### Task 6: Per-request MCP server factory

**Files:**
- Create: `backend/src/modules/marketing/mcp/mcp-server.factory.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-server.factory.spec.ts`

**Interfaces:**
- Consumes: `McpToolRegistry.list(grantedScopes: string[])`; `McpInvokerService.invoke(authInfo, toolName, args)` and `.contextFrom(authInfo)`.
- Produces: `McpServerFactoryService.build(ctx: McpRequestContext): McpServer` — an `McpServer` exposing exactly the tools the caller's scopes permit, every handler delegating to the invoker.

**Design note:** tools are registered *per request* against the caller's scopes, so `tools/list` never leaks the existence of tools the caller cannot use. A `PENDING_APPROVAL` result is returned as normal tool content (not an error) so the model can tell the user their action is queued.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp-server.factory.spec.ts
import { McpToolRegistry } from './mcp-tool-registry';
import { McpServerFactoryService } from './mcp-server.factory';
import type { AuthInfo } from '@modelcontextprotocol/server';

const authInfo = (scopes: string[]): AuthInfo =>
  ({ token: 't', clientId: 'k1', scopes, expiresAt: Math.floor(Date.now() / 1000) + 60, extra: { workspaceId: 'ws1' } }) as AuthInfo;

function deps() {
  const registry = new McpToolRegistry();
  registry.register({
    name: 'jeeta.get_funnel',
    description: 'funnel',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    handler: jest.fn(),
  });
  const invoke = jest.fn().mockResolvedValue({ status: 'OK', result: { stages: [] } });
  const factory = new McpServerFactoryService(registry, { invoke } as any);
  return { factory, invoke, registry };
}

describe('McpServerFactoryService', () => {
  it('builds a server exposing the scoped tools', async () => {
    const { factory } = deps();
    const server = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);
    expect(server).toBeDefined();
  });

  it('refuses to build without authInfo', () => {
    const { factory } = deps();
    expect(() => factory.build({ era: 'modern' } as any)).toThrow(/auth/i);
  });

  it('exposes no tools to a caller lacking the scope', () => {
    const { factory, registry } = deps();
    expect(registry.list(['leads.read'])).toHaveLength(0);
    expect(() => factory.build({ era: 'modern', authInfo: authInfo(['leads.read']) } as any)).not.toThrow();
  });
});

describe('McpServerFactoryService error mapping', () => {
  it('turns a broker rejection into an isError tool result, not a thrown exception', async () => {
    const { factory, invoke } = deps();
    invoke.mockRejectedValue(new ForbiddenException('missing scope(s): leads.write'));
    const server: any = factory.build({ era: 'modern', authInfo: authInfo(['reports.read']) } as any);
    const handler = factory.handlerFor(authInfo(['reports.read']), 'jeeta.get_funnel');
    const out = await handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/missing scope/i);
    expect(server).toBeDefined();
  });

  it('surfaces a pending approval as normal content, not an error', async () => {
    const { factory, invoke } = deps();
    invoke.mockResolvedValue({ status: 'PENDING_APPROVAL', approvalId: 'appr-9' });
    const handler = factory.handlerFor(authInfo(['reports.read']), 'jeeta.get_funnel');
    const out = await handler({});
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain('appr-9');
  });
});
```

Add `import { ForbiddenException } from '@nestjs/common';` at the top of the spec.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-server.factory.spec.ts`
Expected: FAIL — `Cannot find module './mcp-server.factory'`

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/modules/marketing/mcp/mcp-server.factory.ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { McpServer, type AuthInfo, type McpRequestContext } from '@modelcontextprotocol/server';
import { McpToolRegistry } from './mcp-tool-registry';
import { McpInvokerService } from './mcp-invoker.service';

@Injectable()
export class McpServerFactoryService {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly invoker: McpInvokerService,
  ) {}

  /**
   * Builds a fresh McpServer for ONE request. Tools are registered against the
   * caller's granted scopes, so `tools/list` cannot even reveal the existence
   * of a tool this caller may not use.
   */
  build(ctx: McpRequestContext): McpServer {
    const authInfo = ctx.authInfo;
    if (!authInfo) throw new ForbiddenException('missing auth context');

    const server = new McpServer({ name: 'jeeta', version: '1.0.0' });

    for (const meta of this.registry.list(authInfo.scopes ?? [])) {
      // inputSchema is REQUIRED — omitting it makes the SDK call the handler as
      // (ctx) instead of (args, ctx), silently dropping the caller's arguments
      // and passing ServerContext (which carries the bearer token) in their place.
      server.registerTool(
        meta.name,
        { description: meta.description, inputSchema: meta.inputSchema },
        this.handlerFor(authInfo, meta.name),
      );
    }

    return server;
  }

  /**
   * One tool handler. Extracted so it can be unit-tested directly.
   *
   * Two rules encoded here:
   *  - A broker refusal (missing scope, oversized args, unknown tool) becomes a
   *    structured `isError` result rather than a thrown exception, so the model
   *    can read the reason and correct itself instead of the whole request 500ing.
   *  - PENDING_APPROVAL is NOT an error. It is a successful outcome that happens
   *    to require a human, and the text says so explicitly so the model does not
   *    report the action as done.
   */
  handlerFor(authInfo: AuthInfo, toolName: string) {
    return async (args: Record<string, unknown>) => {
      try {
        const res = await this.invoker.invoke(authInfo, toolName, args ?? {});
        if (res.status === 'PENDING_APPROVAL') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Queued for human approval (approvalId: ${res.approvalId}). It has NOT been applied yet.`,
              },
            ],
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(res.result ?? null) }] };
      } catch (err) {
        const message = (err as { message?: string })?.message ?? String(err);
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/marketing/mcp/mcp-server.factory.spec.ts`
Expected: PASS (3 tests)

If `registerTool`'s callback arity differs in the installed SDK, check the declaration:
`grep -A10 "registerTool<" node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts`

- [ ] **Step 5: Commit**

```bash
git add src/modules/marketing/mcp/mcp-server.factory.ts src/modules/marketing/mcp/mcp-server.factory.spec.ts
git commit -m "feat(mcp): build a scope-filtered MCP server per request"
```

---

### Task 7: HTTP transport + module wiring

**Files:**
- Create: `backend/src/modules/marketing/mcp/mcp.controller.ts`
- Create: `backend/src/modules/marketing/mcp/mcp.module.ts`
- Modify: `backend/src/app.module.ts` (import `McpModule`)
- Test: `backend/src/modules/marketing/mcp/mcp.controller.spec.ts`

**Interfaces:**
- Consumes: `McpServerFactoryService.build`, `McpTokenVerifierService.verifyAccessToken`.
- Produces: `POST /api/mcp` speaking MCP Streamable HTTP; 401 with a `WWW-Authenticate` challenge when the bearer token is absent or invalid.

**Critical:** `createMcpHandler` performs **no** token verification — its docs state `authInfo` is "strictly pass-through". Auth must happen before the handler runs, and the verified `AuthInfo` must be passed explicitly into `handler.fetch`.

**Two facts about this app's HTTP wiring, verified in `backend/src/app.config.ts`:**

1. **There is a global `api` prefix** (`app.setGlobalPrefix('api')`, app.config.ts:101). `@Controller('mcp')` therefore serves **`POST /api/mcp`**, not `/mcp`. Every URL in this task — the smoke-test command, the docs, and the RFC 9728 canonical resource URI in Faz 3 — must use `/api/mcp`.
2. **JSON body parsing is already on.** `main.ts` passes `bodyParser: false` to `NestFactory.create`, but `app.config.ts:66` then applies `bodyParser.json({ limit: '200kb' })` globally, so `req.body` is a parsed object by the time the controller runs. Do **not** add a raw-body exemption for this route — the raw-body overrides at app.config.ts:45-55 exist for signature-verifying webhooks, which MCP is not. The 200kb limit is comfortably above the broker's 32KB argument cap.

The global `ValidationPipe` (app.config.ts:136) needs no exemption either: the handler takes `@Req()`/`@Res()` and declares no body DTO, so there is nothing for it to validate.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp.controller.spec.ts
import { McpController } from './mcp.controller';

describe('McpController', () => {
  it('rejects a request with no bearer token', async () => {
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn() } as any;
    const controller = new McpController(factory, verifier);
    const res: any = { status: jest.fn().mockReturnThis(), setHeader: jest.fn(), json: jest.fn(), end: jest.fn() };
    await controller.handle({ headers: {}, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token without building a server', async () => {
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn().mockRejectedValue(new Error('bad')) } as any;
    const controller = new McpController(factory, verifier);
    const res: any = { status: jest.fn().mockReturnThis(), setHeader: jest.fn(), json: jest.fn(), end: jest.fn() };
    await controller.handle({ headers: { authorization: 'Bearer nope' }, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(factory.build).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp.controller.spec.ts`
Expected: FAIL — `Cannot find module './mcp.controller'`

- [ ] **Step 3: Write the controller**

```ts
// backend/src/modules/marketing/mcp/mcp.controller.ts
import { Controller, Post, Req, Res } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { McpServerFactoryService } from './mcp-server.factory';
import { McpTokenVerifierService } from './mcp-token-verifier.service';

/**
 * The MCP Streamable-HTTP endpoint.
 *
 * `createMcpHandler` verifies nothing — `authInfo` is strictly pass-through —
 * so the bearer token is verified HERE and the resulting AuthInfo is handed to
 * the handler explicitly.
 */
@Controller('mcp')
export class McpController {
  private readonly handler: McpHttpHandler;

  constructor(
    private readonly factory: McpServerFactoryService,
    private readonly verifier: McpTokenVerifierService,
  ) {
    this.handler = createMcpHandler((ctx) => this.factory.build(ctx));
  }

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const authz = req.headers?.authorization;
    const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7).trim() : null;

    if (!token) {
      this.challenge(res, 'missing bearer token');
      return;
    }

    let authInfo;
    try {
      authInfo = await this.verifier.verifyAccessToken(token);
    } catch {
      this.challenge(res, 'invalid or revoked token');
      return;
    }

    const response = await this.handler.fetch(this.toFetchRequest(req), { authInfo });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    // Pipe, never buffer. The handler answers with text/event-stream, and an
    // open subscription stream never ends — `await response.arrayBuffer()`
    // would never resolve, pinning the socket and the per-request server for
    // as long as the caller cares to hold it. Buffering also swallows
    // mid-call progress on ordinary tool calls.
    if (!response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as never).pipe(res);
  }

  private challenge(res: Response, description: string): void {
    res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", error_description="${description}"`);
    res.status(401).json({ error: 'invalid_token', error_description: description });
  }

  private toFetchRequest(req: Request): Request_ {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return new Request(url, {
      method: req.method,
      headers: new Headers(req.headers as Record<string, string>),
      body: JSON.stringify(req.body),
    });
  }
}

type Request_ = globalThis.Request;
```

- [ ] **Step 4: Wire into `MarketingModule` — do NOT create a separate module**

⚠️ **This replaces the "create `mcp.module.ts`" instruction in the File Structure table.** `McpToolRegistry`, `McpBrokerService`, `AgentRunService`, `ApprovalRequestService`, `ApiKeysService` and `AnalyticsService` are **already providers of `MarketingModule`** (`marketing.module.ts:888` and nearby). A second module that re-provides them would create second instances — and `AgentRunService` carries `@Cron(CronExpression.EVERY_10_MINUTES, { name: 'agent-run-reaper' })`, so a duplicate instance means `@nestjs/schedule` registering two crons under one name. That fails at boot.

`MarketingModule` also does not export those services, so the import-and-export route would mean surgery on a long export list for no benefit.

So: in `backend/src/modules/marketing/marketing.module.ts`

1. Add `McpController` to the `controllers` array.
2. Add the three new providers — `McpInvokerService`, `McpServerFactoryService`, `McpTokenVerifierService` — to the existing `providers` array, beside `McpToolRegistry` and `McpBrokerService`.
3. Register the tools once at module construction, using the module's existing constructor if it has one, or adding one:

```ts
  constructor(registry: McpToolRegistry, analytics: AnalyticsService) {
    registerAnalyticsTools(registry, { analytics });
  }
```

Do not touch `app.module.ts` — `MarketingModule` is already imported there.

- [ ] **Step 5: Run the tests**

Run: `npm test -- src/modules/marketing/mcp/`
Expected: PASS — all mcp specs green.

- [ ] **Step 6: Verify the app still boots**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors.

If `PrismaModule`'s path differs, find it: `find src -name 'prisma.module.ts'`.

- [ ] **Step 7: Smoke-test against Claude Code**

```bash
# terminal 1
cd backend && npm run start:dev
# terminal 2 — replace with a real key from the workspace's API-keys screen
claude mcp add --transport http jeeta http://localhost:3000/api/mcp \
  --header "Authorization: Bearer mk_live_YOUR_KEY"
claude mcp list
```

Expected: `jeeta` connects and `jeeta.get_funnel` appears in the tool list. Then confirm the audit row exists:

```bash
psql "$DATABASE_URL" -c "select agent, goal, status from agent_runs where agent='mcp' order by \"startedAt\" desc limit 3;"
psql "$DATABASE_URL" -c "select tool, ok from tool_call_logs order by \"createdAt\" desc limit 3;"
```

Expected: one `agent_runs` row with `agent='mcp'`, `goal='jeeta.get_funnel'`, and a matching `tool_call_logs` row.

- [ ] **Step 8: Commit**

```bash
git add src/modules/marketing/mcp/ src/app.module.ts
git commit -m "feat(mcp): expose MCP streamable-http endpoint with bearer auth"
```

---

### Task 8: Remaining Faz-1 read tools

**Files:**
- Create: `backend/src/modules/marketing/mcp/tools/brand.tools.ts`
- Create: `backend/src/modules/marketing/mcp/tools/leads.tools.ts`
- Test: `backend/src/modules/marketing/mcp/tools/brand.tools.spec.ts`
- Test: `backend/src/modules/marketing/mcp/tools/leads.tools.spec.ts`
- Modify: `backend/src/modules/marketing/mcp/mcp.module.ts`

**Interfaces:**
- Consumes: `BrandBrainService.search(workspaceId: string, opts: SearchOptions): Promise<Citation[]>`; `MarketingLeadsService.findAll(workspaceId: string, filter: LeadFilterDto, userId: string, userRole: string)`.
- Produces: `registerBrandTools(registry, { brand: BrandBrainService })` → `jeeta.search_brand_knowledge`; `registerLeadsTools(registry, { leads: MarketingLeadsService })` → `jeeta.search_leads`. Both tools declare a Zod `inputSchema` (mandatory — see Global Constraints).

**⚠️ Principal problem — read this before writing `leads.tools.ts`.** `MarketingLeadsService.findAll` takes `userId` and `userRole` and uses them for row-level visibility (assignee scoping). An API-key-authenticated MCP call has **no user**. Do not paper over this by passing `'OWNER'` inline — that is a silent privilege escalation. Instead define the service principal explicitly in one place, with a comment stating the trade-off, so Faz 3 (OAuth, which *is* user-bound) can replace it with the real user.

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/modules/marketing/mcp/tools/brand.tools.spec.ts
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerBrandTools } from './brand.tools';

describe('brand MCP tools', () => {
  it('registers jeeta.search_brand_knowledge as READ/reports.read', () => {
    const registry = new McpToolRegistry();
    registerBrandTools(registry, { brand: { search: jest.fn() } as any });
    const tool = registry.get('jeeta.search_brand_knowledge')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['reports.read']);
  });

  it('passes the query through to BrandBrainService.search', async () => {
    const registry = new McpToolRegistry();
    const search = jest.fn().mockResolvedValue([{ docId: 'd1' }]);
    registerBrandTools(registry, { brand: { search } as any });
    const out = await registry.get('jeeta.search_brand_knowledge')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'] },
      { query: 'tone of voice' },
    );
    expect(search).toHaveBeenCalledWith('ws1', expect.objectContaining({ query: 'tone of voice' }));
    expect(out).toEqual([{ docId: 'd1' }]);
  });
});
```

```ts
// backend/src/modules/marketing/mcp/tools/leads.tools.spec.ts
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerLeadsTools, MCP_SERVICE_PRINCIPAL } from './leads.tools';

describe('leads MCP tools', () => {
  it('registers jeeta.search_leads as READ/leads.read', () => {
    const registry = new McpToolRegistry();
    registerLeadsTools(registry, { leads: { findAll: jest.fn() } as any });
    const tool = registry.get('jeeta.search_leads')!;
    expect(tool.risk).toBe('READ');
    expect(tool.scopes).toEqual(['leads.read']);
  });

  it('uses the declared service principal when the context carries no user', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry.get('jeeta.search_leads')!.handler({ workspaceId: 'ws1', grantedScopes: ['leads.read'] }, { search: 'ali' });
    expect(findAll).toHaveBeenCalledWith('ws1', expect.objectContaining({ search: 'ali' }), MCP_SERVICE_PRINCIPAL.userId, MCP_SERVICE_PRINCIPAL.role);
  });

  it('prefers a real user id from the context when present', async () => {
    const registry = new McpToolRegistry();
    const findAll = jest.fn().mockResolvedValue([]);
    registerLeadsTools(registry, { leads: { findAll } as any });
    await registry.get('jeeta.search_leads')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['leads.read'], userId: 'u9' },
      {},
    );
    expect(findAll).toHaveBeenCalledWith('ws1', expect.anything(), 'u9', MCP_SERVICE_PRINCIPAL.role);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/modules/marketing/mcp/tools/`
Expected: FAIL — `Cannot find module './brand.tools'` and `'./leads.tools'`

- [ ] **Step 3: Write brand.tools.ts**

```ts
// backend/src/modules/marketing/mcp/tools/brand.tools.ts
import { BrandBrainService } from '../../brand-brain/brand-brain.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface BrandToolDeps {
  brand: BrandBrainService;
}

export function registerBrandTools(registry: McpToolRegistry, deps: BrandToolDeps): void {
  registry.register({
    name: 'jeeta.search_brand_knowledge',
    description:
      'Search the workspace brand profile (tone of voice, positioning, products, policies) and return cited passages. Call this before writing any customer-facing copy.',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    handler: async (ctx, args) =>
      deps.brand.search(ctx.workspaceId, { query: String(args.query ?? '') } as never),
  });
}
```

- [ ] **Step 4: Write leads.tools.ts**

```ts
// backend/src/modules/marketing/mcp/tools/leads.tools.ts
import { MarketingLeadsService } from '../../services/marketing-leads.service';
import { McpToolRegistry } from '../mcp-tool-registry';

/**
 * `MarketingLeadsService.findAll` applies row-level visibility from a user
 * principal, but an API-key MCP session has no user. Until Faz 3 (OAuth, which
 * IS user-bound) we call as an explicit, named service principal rather than
 * silently borrowing an owner identity. Tenancy is still enforced — every query
 * is workspace-scoped — but assignee-level filtering is intentionally bypassed
 * for API-key callers. Narrow this the moment a real user id is available.
 */
export const MCP_SERVICE_PRINCIPAL = { userId: 'mcp-service-principal', role: 'OWNER' } as const;

export interface LeadsToolDeps {
  leads: MarketingLeadsService;
}

export function registerLeadsTools(registry: McpToolRegistry, deps: LeadsToolDeps): void {
  registry.register({
    name: 'jeeta.search_leads',
    description:
      'Search leads in this workspace by free text, stage, source or date range. Returns a paginated list. Read-only.',
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    handler: async (ctx, args) =>
      deps.leads.findAll(
        ctx.workspaceId,
        args as never,
        ctx.userId ?? MCP_SERVICE_PRINCIPAL.userId,
        MCP_SERVICE_PRINCIPAL.role,
      ),
  });
}
```

- [ ] **Step 5: Register both in the module**

In `mcp.module.ts`: import `BrandBrainService`, `MarketingLeadsService`, `registerBrandTools`, `registerLeadsTools`; add the two services to `providers`; extend the constructor:

```ts
  constructor(
    registry: McpToolRegistry,
    analytics: AnalyticsService,
    brand: BrandBrainService,
    leads: MarketingLeadsService,
  ) {
    registerAnalyticsTools(registry, { analytics });
    registerBrandTools(registry, { brand });
    registerLeadsTools(registry, { leads });
  }
```

- [ ] **Step 6: Run tests and build**

Run: `npm test -- src/modules/marketing/mcp/ && npm run build`
Expected: PASS, build clean. If `MarketingLeadsService` needs extra providers, add them to `providers` — the compiler/Nest boot error names them.

- [ ] **Step 7: Commit**

```bash
git add src/modules/marketing/mcp/
git commit -m "feat(mcp): add brand-knowledge and lead-search read tools"
```

---

### Task 9: Per-workspace write mode — schema

**Files:**
- Modify: `backend/prisma/schema.prisma` (`model Workspace`)
- Create: `backend/prisma/migrations/<timestamp>_workspace_mcp_write_mode/migration.sql`
- Create: `backend/prisma/migrations/<timestamp>_workspace_mcp_write_mode/down.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Workspace.mcpWriteMode: string` defaulting to `'APPROVAL'`; values `'APPROVAL' | 'AUTONOMOUS'`.

- [ ] **Step 1: Add the field to the schema**

In `model Workspace`, add:

```prisma
  /// MCP write policy: APPROVAL (default — risky tools queue for a human) or
  /// AUTONOMOUS (risky tools execute inline; audit logging still mandatory).
  mcpWriteMode String @default("APPROVAL")
```

- [ ] **Step 2: Create the migration**

```bash
cd backend && npx prisma migrate dev --name workspace_mcp_write_mode --create-only
```

- [ ] **Step 3: Make the up idempotent**

Edit the generated `migration.sql` to:

```sql
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "mcpWriteMode" TEXT NOT NULL DEFAULT 'APPROVAL';
```

Confirm the table name first: `grep -n '@@map' backend/prisma/schema.prisma | head -3` — use whatever `model Workspace` maps to.

- [ ] **Step 4: Write the down migration**

```sql
-- backend/prisma/migrations/<timestamp>_workspace_mcp_write_mode/down.sql
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "mcpWriteMode";
```

- [ ] **Step 5: Verify the round-trip**

```bash
cd backend
npx prisma migrate deploy
psql "$DATABASE_URL" -f prisma/migrations/<timestamp>_workspace_mcp_write_mode/down.sql
psql "$DATABASE_URL" -f prisma/migrations/<timestamp>_workspace_mcp_write_mode/down.sql   # idempotent: no error
npx prisma migrate deploy
psql "$DATABASE_URL" -c '\d workspaces' | grep mcpWriteMode
```

Expected: the column is present after the final `deploy`, and running `down.sql` twice does not error.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(mcp): add per-workspace mcpWriteMode with reversible migration"
```

---

### Task 10: Per-workspace write mode — broker branch

**Files:**
- Modify: `backend/src/modules/marketing/mcp/mcp-broker.service.ts`
- Modify: `backend/src/modules/marketing/mcp/mcp-invoker.service.ts`
- Test: `backend/src/modules/marketing/mcp/mcp-broker.writemode.spec.ts`

**Interfaces:**
- Consumes: `Workspace.mcpWriteMode` (Task 9).
- Produces: `McpToolContext.writeMode?: 'APPROVAL' | 'AUTONOMOUS'`. When `'AUTONOMOUS'`, a `requiresApproval` tool executes inline instead of enqueuing. Default (unset or `'APPROVAL'`) preserves today's behaviour.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/marketing/mcp/mcp-broker.writemode.spec.ts
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry, McpTool } from './mcp-tool-registry';

function deps() {
  const registry = new McpToolRegistry();
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const recordTool = jest.fn().mockResolvedValue(undefined);
  return { registry, broker: new McpBrokerService(registry, { enqueue } as any, { recordTool } as any), enqueue, recordTool };
}

const spendTool = (handler: jest.Mock): McpTool => ({
  name: 'jeeta.reallocate_budget',
  description: 'move budget',
  scopes: ['settings.manage'],
  risk: 'SPEND',
  requiresApproval: true,
  approvalKind: 'BUDGET_REALLOCATION',
  handler,
});

const ctx = (writeMode?: 'APPROVAL' | 'AUTONOMOUS') => ({
  workspaceId: 'ws1',
  grantedScopes: ['settings.manage'],
  agentRunId: 'run-1',
  requireAudit: true,
  writeMode,
});

describe('McpBrokerService write mode', () => {
  it('queues a risky tool in APPROVAL mode', async () => {
    const { registry, broker, enqueue } = deps();
    const handler = jest.fn();
    registry.register(spendTool(handler));
    const res = await broker.invoke(ctx('APPROVAL'), 'jeeta.reallocate_budget', { amount: 100 });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('executes a risky tool inline in AUTONOMOUS mode', async () => {
    const { registry, broker, enqueue, recordTool } = deps();
    const handler = jest.fn().mockResolvedValue({ moved: 100 });
    registry.register(spendTool(handler));
    const res = await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.reallocate_budget', { amount: 100 });
    expect(res).toEqual({ status: 'OK', result: { moved: 100 } });
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('still writes the audit log in AUTONOMOUS mode', async () => {
    const { registry, broker, recordTool } = deps();
    registry.register(spendTool(jest.fn().mockResolvedValue({ moved: 100 })));
    await broker.invoke(ctx('AUTONOMOUS'), 'jeeta.reallocate_budget', { amount: 100 });
    expect(recordTool).toHaveBeenCalled();
  });

  it('defaults to queuing when write mode is unset', async () => {
    const { registry, broker, enqueue } = deps();
    registry.register(spendTool(jest.fn()));
    const res = await broker.invoke(ctx(), 'jeeta.reallocate_budget', {});
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(enqueue).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/marketing/mcp/mcp-broker.writemode.spec.ts`
Expected: FAIL — the AUTONOMOUS test gets `PENDING_APPROVAL`.

- [ ] **Step 3: Add the field to the context**

In `mcp-tool-registry.ts`, extend `McpToolContext`:

```ts
  /** Per-workspace MCP write policy. Unset behaves as 'APPROVAL'. */
  writeMode?: 'APPROVAL' | 'AUTONOMOUS';
```

- [ ] **Step 4: Change the approval branch**

In `mcp-broker.service.ts`, change the existing guard from:

```ts
    if (tool.requiresApproval) {
```

to:

```ts
    if (tool.requiresApproval && ctx.writeMode !== 'AUTONOMOUS') {
```

Leave the body of that branch untouched.

- [ ] **Step 5: Load the mode in the invoker**

In `mcp-invoker.service.ts`, inject `PrismaService`, read the workspace once per invocation, and pass it through:

```ts
  constructor(
    private readonly broker: McpBrokerService,
    private readonly runs: AgentRunService,
    private readonly prisma: PrismaService,
  ) {}

  private async writeModeFor(workspaceId: string): Promise<'APPROVAL' | 'AUTONOMOUS'> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { mcpWriteMode: true },
    });
    return ws?.mcpWriteMode === 'AUTONOMOUS' ? 'AUTONOMOUS' : 'APPROVAL';
  }
```

and in `invoke()`, resolve it before `track()` and add `writeMode` to the context object passed to `broker.invoke`.

Update `mcp-invoker.service.spec.ts`'s `deps()` to pass a third constructor argument:
`{ workspace: { findUnique: jest.fn().mockResolvedValue({ mcpWriteMode: 'APPROVAL' }) } } as any`.

- [ ] **Step 6: Run the whole mcp suite**

Run: `npm test -- src/modules/marketing/mcp/`
Expected: PASS — including the untouched `mcp-broker.service.spec.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/modules/marketing/mcp/
git commit -m "feat(mcp): honour per-workspace write mode in the broker"
```

---

### Task 11: Faz-2 tool catalogue — inbox and campaigns

**Files:**
- Create: `backend/src/modules/marketing/mcp/tools/inbox.tools.ts`
- Create: `backend/src/modules/marketing/mcp/tools/campaigns.tools.ts`
- Test: `backend/src/modules/marketing/mcp/tools/inbox.tools.spec.ts`
- Test: `backend/src/modules/marketing/mcp/tools/campaigns.tools.spec.ts`
- Modify: `backend/src/modules/marketing/mcp/mcp.module.ts`

**Interfaces:**
- Consumes: the inbox and campaigns services. **Before writing, discover the exact method names** — do not guess:
  `grep -rnE "^  (async )?[a-z][A-Za-z]*\(" src/modules/marketing/inbox/*.service.ts src/modules/marketing/campaigns/*.service.ts`
- Produces: `registerInboxTools`, `registerCampaignsTools`.

**Catalogue for this task** — every tool is registered with exactly these values, **plus a Zod `inputSchema` describing its arguments** (mandatory — see Global Constraints; omitting it breaks handler arity and leaks the bearer token into the audit log):

| Tool name | scopes | risk | requiresApproval | approvalKind |
|---|---|---|---|---|
| `jeeta.list_conversations` | `['contacts.read']` | READ | false | — |
| `jeeta.read_conversation` | `['contacts.read']` | READ | false | — |
| `jeeta.send_message` | `['contacts.write']` | WRITE | **true** | `SEND` |
| `jeeta.list_campaigns` | `['campaigns.read']` | READ | false | — |
| `jeeta.get_campaign_performance` | `['reports.read']` | READ | false | — |
| `jeeta.set_campaign_status` | `['campaigns.send']` | WRITE | **true** | `PUBLISH` |

- [ ] **Step 1: Write the failing test for the gated tool**

```ts
// backend/src/modules/marketing/mcp/tools/inbox.tools.spec.ts
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerInboxTools } from './inbox.tools';

const deps = () => ({ inbox: { list: jest.fn(), read: jest.fn(), send: jest.fn() } as any });

describe('inbox MCP tools', () => {
  it('registers the read tools without an approval gate', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    expect(registry.get('jeeta.list_conversations')!.requiresApproval).toBe(false);
    expect(registry.get('jeeta.read_conversation')!.requiresApproval).toBe(false);
  });

  it('gates jeeta.send_message behind SEND approval', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    const tool = registry.get('jeeta.send_message')!;
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('SEND');
    expect(tool.scopes).toEqual(['contacts.write']);
  });

  it('hides send_message from a read-only caller', () => {
    const registry = new McpToolRegistry();
    registerInboxTools(registry, deps());
    expect(registry.list(['contacts.read']).map((t) => t.name)).not.toContain('jeeta.send_message');
  });
});
```

Write the equivalent `campaigns.tools.spec.ts` asserting `jeeta.set_campaign_status` has `requiresApproval: true`, `approvalKind: 'PUBLISH'`, `scopes: ['campaigns.send']`, and that `jeeta.list_campaigns` / `jeeta.get_campaign_performance` are ungated READs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/modules/marketing/mcp/tools/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the tool modules**

`inbox.tools.ts` in full — `campaigns.tools.ts` is the same shape, one `registry.register({...})` per remaining row of the catalogue table. Replace `deps.inbox.*` calls with the real method names discovered in the Interfaces step.

```ts
// backend/src/modules/marketing/mcp/tools/inbox.tools.ts
import { McpToolRegistry } from '../mcp-tool-registry';

export interface InboxToolDeps {
  // Type this as the real inbox service once its name is known.
  inbox: { list: Function; read: Function; send: Function };
}

export function registerInboxTools(registry: McpToolRegistry, deps: InboxToolDeps): void {
  registry.register({
    name: 'jeeta.list_conversations',
    description: 'List conversations in the shared inbox, newest first. Read-only.',
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    handler: async (ctx, args) => deps.inbox.list(ctx.workspaceId, args),
  });

  registry.register({
    name: 'jeeta.read_conversation',
    description: 'Read the full message history of one conversation by id. Read-only.',
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    handler: async (ctx, args) => deps.inbox.read(ctx.workspaceId, String(args.conversationId ?? '')),
  });

  registry.register({
    name: 'jeeta.send_message',
    description:
      'Send a reply in a conversation. This reaches a real customer, so in APPROVAL mode it is queued for a human instead of sending immediately.',
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    handler: async (ctx, args) =>
      deps.inbox.send(ctx.workspaceId, String(args.conversationId ?? ''), String(args.body ?? '')),
  });
}
```

- [ ] **Step 4: Register in the module**

Add the two services to `providers` and the two `register…Tools(...)` calls to the `McpModule` constructor, matching Task 8's pattern.

- [ ] **Step 5: Run tests and build**

Run: `npm test -- src/modules/marketing/mcp/ && npm run build`
Expected: PASS, build clean.

- [ ] **Step 6: Verify the approval gate end-to-end**

With the server running and the workspace in default `APPROVAL` mode, call `jeeta.send_message` from Claude Code. Expected: the tool returns the "Queued for human approval" text and a row appears in `approval_requests` with `status='PENDING'` — and **no** message is sent.

```bash
psql "$DATABASE_URL" -c "select kind, status, summary from approval_requests order by \"createdAt\" desc limit 1;"
```

- [ ] **Step 7: Commit**

```bash
git add src/modules/marketing/mcp/
git commit -m "feat(mcp): add inbox and campaign tools with approval gating"
```

---

### Task 12: Faz-2 tool catalogue — social, ads, scheduling, workspace

**Files:**
- Create: `backend/src/modules/marketing/mcp/tools/social.tools.ts`
- Create: `backend/src/modules/marketing/mcp/tools/ads.tools.ts`
- Create: `backend/src/modules/marketing/mcp/tools/scheduling.tools.ts`
- Create: `backend/src/modules/marketing/mcp/tools/workspace.tools.ts`
- Test: one `*.spec.ts` beside each
- Modify: `backend/src/modules/marketing/mcp/mcp.module.ts`

**Interfaces:**
- Consumes: the social-planner, ads/budget, scheduling and workspace services. **Discover exact method names before writing:**
  `grep -rnE "^  (async )?[a-z][A-Za-z]*\(" src/modules/marketing/social-planner/*.service.ts src/modules/marketing/ads/*.service.ts src/modules/marketing/budget/*.service.ts src/modules/marketing/scheduling/*.service.ts`
- Produces: `registerSocialTools`, `registerAdsTools`, `registerSchedulingTools`, `registerWorkspaceTools`.

**Catalogue for this task** — each tool also declares a Zod `inputSchema` for its arguments (mandatory — see Global Constraints):

| Tool name | scopes | risk | requiresApproval | approvalKind |
|---|---|---|---|---|
| `jeeta.list_scheduled_posts` | `['campaigns.read']` | READ | false | — |
| `jeeta.draft_social_post` | `['campaigns.read']` | WRITE | false | — |
| `jeeta.publish_social_post` | `['campaigns.send']` | WRITE | **true** | `PUBLISH` |
| `jeeta.get_ad_performance` | `['reports.read']` | READ | false | — |
| `jeeta.get_budget` | `['reports.read']` | READ | false | — |
| `jeeta.reallocate_budget` | `['settings.manage']` | SPEND | **true** | `BUDGET_REALLOCATION` |
| `jeeta.list_bookings` | `['tasks.read']` | READ | false | — |
| `jeeta.get_booking_availability` | `['tasks.read']` | READ | false | — |
| `jeeta.get_workspace_info` | `['reports.read']` | READ | false | — |

⚠️ **Corrected against the real codebase.** This plan originally listed an "appointments" vertical (`jeeta.list_appointments` / `get_availability` / `create_appointment`). There is no `Appointment` model and no `prisma.appointment` usage — the domain is **bookings** (`BookingCalendar`, `Booking`, `BookingBlackout`), served by `BookingService` in `sites/booking.service.ts` (`listBookings`, `listMemberAvailability`, `publicCalendar`, `list` for calendars). The two read tools are renamed accordingly. **`create_appointment` is dropped**: booking creation is a customer-facing flow, and wiring an MCP tool into it was not part of any validated requirement. Do not invent a server-side creation path to satisfy the old table.

`jeeta.draft_social_post` is deliberately ungated: creating a **draft** has no external side effect. Only `publish` reaches an audience, and only it is gated.

- [ ] **Step 1: Write the failing tests**

`ads.tools.spec.ts` in full. Write the other three the same way, substituting each file's tool names and the scopes/risk/approvalKind from the catalogue table.

```ts
// backend/src/modules/marketing/mcp/tools/ads.tools.spec.ts
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerAdsTools } from './ads.tools';

const deps = () => ({ ads: { performance: jest.fn(), getBudget: jest.fn(), reallocate: jest.fn() } as any });

describe('ads MCP tools', () => {
  it('registers the read tools ungated', () => {
    const registry = new McpToolRegistry();
    registerAdsTools(registry, deps());
    expect(registry.get('jeeta.get_ad_performance')!.requiresApproval).toBe(false);
    expect(registry.get('jeeta.get_budget')!.scopes).toEqual(['reports.read']);
  });

  it('gates jeeta.reallocate_budget as SPEND behind BUDGET_REALLOCATION', () => {
    const registry = new McpToolRegistry();
    registerAdsTools(registry, deps());
    const tool = registry.get('jeeta.reallocate_budget')!;
    expect(tool.risk).toBe('SPEND');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('BUDGET_REALLOCATION');
    expect(tool.scopes).toEqual(['settings.manage']);
  });

  it('forwards the context workspace to the service', async () => {
    const registry = new McpToolRegistry();
    const d = deps();
    registerAdsTools(registry, d);
    await registry.get('jeeta.get_ad_performance')!.handler(
      { workspaceId: 'ws1', grantedScopes: ['reports.read'] },
      { from: '2026-07-01', to: '2026-07-28' },
    );
    expect(d.ads.performance).toHaveBeenCalledWith('ws1', expect.anything());
  });

  it('hides reallocate_budget from a caller without settings.manage', () => {
    const registry = new McpToolRegistry();
    registerAdsTools(registry, deps());
    expect(registry.list(['reports.read']).map((t) => t.name)).not.toContain('jeeta.reallocate_budget');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/modules/marketing/mcp/tools/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the four tool modules**

Same shape as `analytics.tools.ts`, one `registry.register({...})` per catalogue row.

- [ ] **Step 4: Register in the module and run**

Run: `npm test -- src/modules/marketing/mcp/ && npm run build`
Expected: PASS, build clean.

- [ ] **Step 5: Verify the catalogue size**

```bash
npm test -- src/modules/marketing/mcp/
```

Then add a registry-count assertion to `mcp.module.spec.ts` (create it) asserting the total number of registered tools equals the catalogue total, so an accidentally-dropped registration fails CI.

- [ ] **Step 6: Commit**

```bash
git add src/modules/marketing/mcp/
git commit -m "feat(mcp): add social, ads, scheduling and workspace tools"
```

---

### Task 13: Documentation and connector setup guide

**Files:**
- Create: `docs/marketing/mcp-connector.md`

- [ ] **Step 1: Write the guide**

Cover: what the endpoint is (`POST /api/mcp`), how to mint an API key, the exact `claude mcp add` command, the full tool catalogue table (name / scopes / risk / gated), how approval-gated tools behave, how to switch a workspace to `AUTONOMOUS`, and where the audit trail lives (`agent_runs` + `tool_call_logs`).

- [ ] **Step 2: Verify the commands in the guide actually work**

Run each command from the guide against a local server and confirm the described output.

- [ ] **Step 3: Commit**

```bash
git add docs/marketing/mcp-connector.md
git commit -m "docs(mcp): add connector setup and tool catalogue guide"
```

---

## Deviations from the design spec

Two corrections found while grounding this plan against the code:

1. **Scope format.** Spec §5.3 proposed colon-style scopes (`leads:write`). The codebase already has a dot-style permission vocabulary in `marketing/roles/permissions.ts`, used by `permissions.guard.ts` and by the existing broker spec. This plan uses the existing vocabulary; introducing a parallel one would have been a latent bug.

2. **No separate session service.** The spec's file list included `mcp-session.service.ts` for `AgentRun` lifecycle. `AgentRunService.track()` already implements start → run → finish/fail, so the invoker uses it directly and no session service is needed. Trade-off: one `AgentRun` per tool call rather than per MCP session. That is simpler, replica-safe, and loses no audit fidelity; grouping calls under a session-level run is a possible later refinement.

One item is **carried forward, not solved**: `MarketingLeadsService.findAll` needs a user principal for row-level visibility, and API-key sessions have none. Task 8 makes the service principal explicit and named rather than hiding it. Faz 3 (OAuth) is user-bound and should replace it.
