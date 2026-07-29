import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./marketingApi', () => ({ default: { get, post } }));

import { applyRequest, isMcpApprovalPayload } from './growthBudget.service';

/**
 * `isMcpApprovalPayload` is the discriminator BudgetAutopilotPage uses to
 * route an approval to approve-then-apply (MCP) vs. approve-only /
 * applyReallocation. It must mirror the backend's `isMcpPayload` in
 * mcp-approval-executor.service.ts exactly, because `kind` alone can't tell
 * an MCP `jeeta.reallocate_budget` call apart from a Budget Autopilot
 * proposal — both use kind BUDGET_REALLOCATION.
 */
describe('isMcpApprovalPayload', () => {
  it('is true for the { tool, args } shape the MCP broker enqueues', () => {
    expect(isMcpApprovalPayload({ tool: 'jeeta.send_message', args: { to: '+1', body: 'hi' } })).toBe(true);
  });

  it('is true even when args is empty', () => {
    expect(isMcpApprovalPayload({ tool: 'jeeta.get_budget', args: {} })).toBe(true);
  });

  it('is false for the Budget Autopilot reallocation payload shape', () => {
    expect(isMcpApprovalPayload({ budgetId: 'b1', runId: 'r1', after: [] })).toBe(false);
  });

  it('is false for null/undefined/non-object payloads', () => {
    expect(isMcpApprovalPayload(null)).toBe(false);
    expect(isMcpApprovalPayload(undefined)).toBe(false);
    expect(isMcpApprovalPayload('a string')).toBe(false);
  });

  it('is false when tool is missing or empty', () => {
    expect(isMcpApprovalPayload({ args: {} })).toBe(false);
    expect(isMcpApprovalPayload({ tool: '', args: {} })).toBe(false);
  });

  it('is false when args is an array or missing', () => {
    expect(isMcpApprovalPayload({ tool: 'jeeta.send_message', args: [] })).toBe(false);
    expect(isMcpApprovalPayload({ tool: 'jeeta.send_message' })).toBe(false);
  });
});

describe('applyRequest', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('POSTs to /approvals/:id/apply', async () => {
    post.mockResolvedValue({ data: { status: 'APPLIED', result: { sent: true } } });
    const result = await applyRequest('ap1');
    expect(post).toHaveBeenCalledWith('/approvals/ap1/apply');
    expect(result).toEqual({ status: 'APPLIED', result: { sent: true } });
  });
});
