import { AskAiService } from './ask-ai.service';

/**
 * Ask-AI runs a Claude tool-loop over workspace-scoped READ tools and returns
 * the final answer; it meters a credit and refunds on failure. Tools never
 * span tenants (every query carries workspaceId).
 */
describe('AskAiService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let anthropic: any;
  let credits: any;
  let svc: AskAiService;

  beforeEach(() => {
    prisma = {
      lead: {
        groupBy: jest.fn().mockResolvedValue([{ status: 'NEW', _count: { _all: 5 } }]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      marketingTask: { findMany: jest.fn().mockResolvedValue([]) },
      campaign: { findMany: jest.fn().mockResolvedValue([]) },
    };
    anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn() };
    credits = { reserve: jest.fn(), refund: jest.fn() };
    svc = new AskAiService(prisma as any, anthropic as any, credits as any);
  });

  it('runs the tool-loop and returns the final answer (metered)', async () => {
    anthropic.complete
      .mockResolvedValueOnce({ text: '', toolUses: [{ type: 'tool_use', id: 't1', name: 'lead_stats', input: {} }], stopReason: 'tool_use', usage: {} })
      .mockResolvedValueOnce({ text: 'You have 5 NEW leads.', toolUses: [], stopReason: 'end_turn', usage: {} });

    const res = await svc.ask(WS, 'How many new leads?');
    expect(res.answer).toBe('You have 5 NEW leads.');
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    // the read tool ran, workspace-scoped + active leads only
    expect(prisma.lead.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, deletedAt: null, mergedIntoId: null }) }),
    );
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('refunds the credit if the model call fails', async () => {
    anthropic.complete.mockRejectedValue(new Error('api down'));
    await expect(svc.ask(WS, 'hi')).rejects.toThrow('api down');
    expect(credits.refund).toHaveBeenCalledTimes(1);
  });

  it('search_leads binds the workspaceId (no cross-tenant read)', async () => {
    anthropic.complete
      .mockResolvedValueOnce({ text: '', toolUses: [{ type: 'tool_use', id: 't1', name: 'search_leads', input: { query: 'cafe', status: 'new' } }], stopReason: 'tool_use', usage: {} })
      .mockResolvedValueOnce({ text: 'done', toolUses: [], stopReason: 'end_turn', usage: {} });
    await svc.ask(WS, 'find cafes');
    const where = prisma.lead.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(WS);
    expect(where.status).toBe('NEW');
    // active leads only — the AI must not surface soft-deleted / merged contacts
    expect(where.deletedAt).toBeNull();
    expect(where.mergedIntoId).toBeNull();
  });
});
