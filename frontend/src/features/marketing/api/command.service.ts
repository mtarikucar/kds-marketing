import marketingApi from './marketingApi';

export interface CommandAction {
  tool: string;
  status: 'OK' | 'PENDING_APPROVAL' | 'ERROR';
  approvalId?: string;
  error?: string;
}

export interface CommandResult {
  answer: string;
  actions: CommandAction[];
  runId: string;
}

export interface AgentRunToolCall {
  id: string;
  tool: string;
  ok: boolean;
  error?: string | null;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agent: string;
  goal?: string | null;
  status: string;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  toolCalls: AgentRunToolCall[];
}

/**
 * POST /marketing/ai/command — the home screen's command bar.
 *
 * Unlike `/marketing/ai/ask` (a read-only analyst) this one ACTS: it runs a
 * tool-loop over the workspace's MCP catalogue through the broker, so anything
 * risky comes back as PENDING_APPROVAL and lands in the approval queue on the
 * same screen rather than executing silently.
 */
export const runCommand = (command: string) =>
  marketingApi.post<CommandResult>('/ai/command', { command }).then((r: { data: CommandResult }) => r.data);

/** GET /marketing/approvals/agent-runs — what the agent has been doing. */
export const listAgentRuns = () =>
  marketingApi.get<AgentRun[]>('/approvals/agent-runs').then((r: { data: AgentRun[] }) => r.data);
