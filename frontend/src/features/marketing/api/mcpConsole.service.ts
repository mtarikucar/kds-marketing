/**
 * mcpConsole.service.ts — typed client for the MCP connector console (Faz 4).
 *
 * Thin wrappers over `marketingApi` (base `${API_URL}/marketing`), matching the
 * repo convention: one plain fn per endpoint returning `r.data`, with the React
 * Query hooks left to the page.
 *
 * Every date the backend selects is a Prisma `DateTime`, which arrives here as
 * an ISO STRING after JSON transport — so the interfaces below type them as
 * `string`, not `Date`. Anything that formats them must go through
 * `fmtDateTime`, never `d.getTime()`.
 *
 * Gating mirrors the backend so the caller can render honestly:
 *  - everything under `/mcp-console` is MANAGER-gated (`McpConsoleController`);
 *  - the REVOKE additionally demands `settings.manage`;
 *  - the write-mode PATCH lives on a DIFFERENT controller
 *    (`marketing/workspaces/mcp-write-mode`) and is OWNER-only. Ask
 *    `overview().canToggle` before offering it — it mirrors both of that
 *    endpoint's gates.
 */
import marketingApi from './marketingApi';

// ── Write mode ───────────────────────────────────────────────────────────────

/** Mirrors `Workspace.mcpWriteMode` / `SetMcpWriteModeDto`. */
export type McpWriteMode = 'APPROVAL' | 'AUTONOMOUS';

export interface McpWriteModeState {
  mcpWriteMode: McpWriteMode;
}

// ── Research execution ───────────────────────────────────────────────────────

/** Mirrors `Workspace.researchExecution` / `SetResearchExecutionDto`. */
export type ResearchExecution = 'SERVER' | 'MCP';

export interface ResearchExecutionState {
  researchExecution: ResearchExecution;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface McpConsoleOverview {
  mcpWriteMode: McpWriteMode;
  /** Which side drains the nightly research queue. See `setResearchExecution`. */
  researchExecution: ResearchExecution;
  /**
   * Whether THIS caller may flip EITHER switch (OWNER + `settings.manage`).
   *
   * One flag because both PATCH routes carry the identical pair of gates. The
   * backend resolves it once; if the gates ever diverge it splits in two there
   * and here together.
   */
  canToggle: boolean;
  /** The canonical MCP resource URI to paste into a client — null when the
   *  deployment has no PUBLIC_BASE_URL configured. */
  mcpEndpoint: string | null;
  liveConnectionCount: number;
  pendingApprovalCount: number;
}

// ── Connections ──────────────────────────────────────────────────────────────

export interface McpOAuthConnection {
  kind: 'OAUTH';
  /** The CIMD `client_id` — an https URL, and the client's identity. */
  clientId: string;
  clientName: string | null;
  logoUri: string | null;
  clientUri: string | null;
  scopes: string[];
  connectedAt: string | null;
  lastActivityAt: string | null;
  liveTokenCount: number;
}

export interface McpApiKeyConnection {
  kind: 'API_KEY';
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

export interface McpConnections {
  oauth: McpOAuthConnection[];
  apiKeys: McpApiKeyConnection[];
}

/** What `revokeMcpOAuthConnection` reports back: how many tokens it stamped. */
export interface McpRevokeResult {
  clientId: string;
  revoked: number;
}

// ── Sessions & audit ─────────────────────────────────────────────────────────

export interface McpSessionSummary {
  id: string;
  status: string;
  /** Whatever the run recorded — today the TOOL NAME (one run per tool call).
   *  Passed through verbatim; the console never embellishes it. */
  goal: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  toolCallCount: number;
  approvalCount: number;
}

/**
 * One audited tool call.
 *
 * The backend deliberately returns NO payload bodies — `args`/`result` routinely
 * hold customer PII, so it exposes their SIZE plus the top-level argument KEY
 * NAMES and nothing else. The UI must present sizes/keys as sizes/keys and must
 * never imply it is showing content.
 */
export interface McpToolCallAudit {
  id: string;
  tool: string;
  at: string;
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
  argsBytes: number;
  argsKeys: string[];
  resultBytes: number;
}

export interface McpApprovalSummary {
  id: string;
  kind: string;
  status: string;
  summary: string;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

export interface McpSessionDetail {
  id: string;
  status: string;
  goal: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  queuedForApproval: boolean;
  toolCalls: McpToolCallAudit[];
  approvals: McpApprovalSummary[];
}

export interface McpSessionPage {
  items: McpSessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Calls ────────────────────────────────────────────────────────────────────

/** Console header: mode, whether this caller may flip it, endpoint + counts. */
export const getMcpConsoleOverview = (): Promise<McpConsoleOverview> =>
  marketingApi.get('/mcp-console/overview').then((r) => r.data);

/** Connected Claude.ai/Desktop connectors + the workspace's live MCP API keys. */
export const getMcpConnections = (): Promise<McpConnections> =>
  marketingApi.get('/mcp-console/connections').then((r) => r.data);

/**
 * Disconnect one OAuth client — revoke every live token it holds here.
 *
 * `clientId` is a CIMD `client_id`, i.e. an https URL, so it MUST be
 * percent-encoded before it goes into the path: unencoded slashes would split
 * it across path segments and miss the route entirely (Express decodes the
 * `%2F`-encoded param back for the handler).
 */
export const revokeMcpOAuthConnection = (clientId: string): Promise<McpRevokeResult> =>
  marketingApi
    .delete(`/mcp-console/connections/oauth/${encodeURIComponent(clientId)}`)
    .then((r) => r.data);

/** MCP sessions, newest first. The page size is capped server-side. */
export const listMcpSessions = (page = 1, pageSize = 25): Promise<McpSessionPage> =>
  marketingApi.get('/mcp-console/sessions', { params: { page, pageSize } }).then((r) => r.data);

/** One session with its tool-call audit rows (payload blobs summarised only). */
export const getMcpSession = (id: string): Promise<McpSessionDetail> =>
  marketingApi.get(`/mcp-console/sessions/${id}`).then((r) => r.data);

/**
 * Read the write mode straight from its own endpoint.
 *
 * OWNER-only and `@Audit`-logged, which is why the console page reads the mode
 * out of `overview()` instead (MANAGER-readable, no audit noise on a page
 * load). Exposed here for callers that are already known to be an OWNER and
 * want a fresh read-back rather than the whole overview.
 */
export const getMcpWriteMode = (): Promise<McpWriteModeState> =>
  marketingApi.get('/workspaces/mcp-write-mode').then((r) => r.data);

/**
 * Flip the human-approval gate. OWNER + `settings.manage` only — check
 * `overview().canToggle` first, or this 403s.
 *
 * PATCH, not PUT: `MarketingWorkspacesController.setMcpWriteMode` is
 * `@Patch('mcp-write-mode')`.
 */
export const setMcpWriteMode = (mode: McpWriteMode): Promise<McpWriteModeState> =>
  marketingApi.patch('/workspaces/mcp-write-mode', { mode }).then((r) => r.data);

/**
 * Hand the nightly research queue to the workspace's own Claude, or take it
 * back. OWNER + `settings.manage` only — check `overview().canToggle` first,
 * or this 403s.
 *
 * The current value comes from `overview()`, not from this endpoint's own GET:
 * that one is OWNER-only and `@Audit`-logged, so reading it on every console
 * render would 403 a MANAGER off the page and write an audit row per load.
 */
export const setResearchExecution = (
  mode: ResearchExecution,
): Promise<ResearchExecutionState> =>
  marketingApi.patch('/workspaces/research-execution', { mode }).then((r) => r.data);
