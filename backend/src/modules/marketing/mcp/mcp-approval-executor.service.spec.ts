import { BadRequestException, NotFoundException } from '@nestjs/common';
import { McpApprovalExecutorService } from './mcp-approval-executor.service';

/**
 * This executor is the "approve → EXECUTE" capstone for MCP write tools
 * (mirrors BudgetExecutorService for the reallocation lane). Coverage here
 * mirrors the money-safety posture: never execute a non-MCP payload (a
 * budget-autopilot approval must keep flowing through BudgetExecutorService),
 * never execute anything but an APPROVED request, and never mark applied
 * unless the tool actually ran.
 */
describe('McpApprovalExecutorService', () => {
  const WS = 'ws1';
  const APPROVAL = 'appr1';
  const USER = 'user1';
  const TOOL = 'jeeta.reallocate_budget';

  function make(overrides: { approval?: any } = {}) {
    const prisma = {
      approvalRequest: { findFirst: jest.fn().mockResolvedValue(overrides.approval ?? null) },
    };
    const approvals = { markApplied: jest.fn().mockResolvedValue({ id: APPROVAL, status: 'APPLIED' }) };
    const broker = { invoke: jest.fn().mockResolvedValue({ status: 'OK', result: { moved: 100 } }) };
    const runs = {
      track: jest.fn((_workspaceId: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => fn('run-1')),
    };
    const registry = { get: jest.fn().mockReturnValue({ name: TOOL, scopes: ['settings.manage'] }) };
    const svc = new McpApprovalExecutorService(prisma as any, approvals as any, broker as any, runs as any, registry as any);
    return { svc, prisma, approvals, broker, runs, registry };
  }

  const mcpApproval = (status = 'APPROVED', payload: any = { tool: TOOL, args: { amount: 100 } }) => ({
    id: APPROVAL,
    workspaceId: WS,
    kind: 'AD_SPEND',
    status,
    payload,
  });

  it('404s when the approval is missing or belongs to another workspace', async () => {
    const { svc } = make({ approval: null });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a non-MCP payload (e.g. a budget-autopilot reallocation)', async () => {
    const { svc, broker } = make({ approval: mcpApproval('APPROVED', { budgetId: 'b1', runId: 'r1', after: [] }) });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects a PENDING request', async () => {
    const { svc, broker } = make({ approval: mcpApproval('PENDING') });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects a REJECTED request', async () => {
    const { svc, broker } = make({ approval: mcpApproval('REJECTED') });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects an already-APPLIED request', async () => {
    const { svc, broker } = make({ approval: mcpApproval('APPLIED') });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects an EXPIRED request', async () => {
    const { svc, broker } = make({ approval: mcpApproval('EXPIRED') });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('executes the tool and marks the request applied on success', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval() });
    const out = await svc.apply(WS, APPROVAL, USER);
    expect(broker.invoke).toHaveBeenCalled();
    expect(approvals.markApplied).toHaveBeenCalledWith(WS, APPROVAL);
    expect(out).toEqual({ status: 'APPLIED', result: { moved: 100 } });
  });

  it('carries approvedBy + requireAudit + the run-scoped agentRunId into the broker context', async () => {
    const { svc, broker } = make({ approval: mcpApproval() });
    await svc.apply(WS, APPROVAL, USER);
    expect(broker.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        agentRunId: 'run-1',
        requireAudit: true,
        approvedBy: { approvalId: APPROVAL, userId: USER },
      }),
      TOOL,
      { amount: 100 },
    );
  });

  it('grants the scopes the tool itself declares (the human already authorised this specific call)', async () => {
    const { svc, broker, registry } = make({ approval: mcpApproval() });
    registry.get.mockReturnValue({ name: TOOL, scopes: ['settings.manage', 'ads.write'] });
    await svc.apply(WS, APPROVAL, USER);
    expect(broker.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ['settings.manage', 'ads.write'] }),
      TOOL,
      { amount: 100 },
    );
  });

  it('does not mark applied when the tool execution fails, and surfaces the error', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval() });
    broker.invoke.mockRejectedValue(new Error('provider rejected the write'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toThrow('provider rejected the write');
    expect(approvals.markApplied).not.toHaveBeenCalled();
  });
});
