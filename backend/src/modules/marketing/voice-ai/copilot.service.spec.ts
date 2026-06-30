import { CopilotService } from './copilot.service';

function makeDeps() {
  const prisma = {
    agentProfile: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const anthropic = { complete: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const knowledge = { search: jest.fn().mockResolvedValue([]) };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const svc = new CopilotService(prisma as any, anthropic as any, credits as any, knowledge as any);
  return { prisma, anthropic, knowledge, credits, svc };
}

const TRANSCRIPT = 'Customer: Fiyat nedir?\nRep: Bir saniye.';

describe('CopilotService', () => {
  it('inert: returns empty when Anthropic is not enabled (no throw, no spend)', async () => {
    const { anthropic, credits, svc } = makeDeps();
    anthropic.isEnabled.mockReturnValue(false);

    const r = await svc.suggest('ws-1', 'agent-1', TRANSCRIPT);

    expect(r).toEqual({ suggestions: [], summary: '' });
    expect(anthropic.complete).not.toHaveBeenCalled();
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('happy path: parses suggestions + summary from STRICT JSON', async () => {
    const { anthropic, credits, svc } = makeDeps();
    anthropic.complete.mockResolvedValue({
      text: JSON.stringify({ suggestions: ['Fiyat 100 TL deyin', 'İndirim sunun'], summary: 'Fiyat sorgusu' }),
    });

    const r = await svc.suggest('ws-1', 'agent-1', TRANSCRIPT);

    expect(r.suggestions).toEqual(['Fiyat 100 TL deyin', 'İndirim sunun']);
    expect(r.summary).toBe('Fiyat sorgusu');
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 1);
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('loads AgentProfile and grounds KB on the last customer line', async () => {
    const { prisma, anthropic, knowledge, svc } = makeDeps();
    prisma.agentProfile.findFirst.mockResolvedValue({
      id: 'agent-1', workspaceId: 'ws-1', persona: 'Satışçı', guardrails: 'No promises', language: 'tr', kbDocIds: ['d1'],
    });
    anthropic.complete.mockResolvedValue({ text: '{"suggestions":[],"summary":""}' });

    await svc.suggest('ws-1', 'agent-1', TRANSCRIPT);

    expect(prisma.agentProfile.findFirst).toHaveBeenCalledWith({ where: { id: 'agent-1', workspaceId: 'ws-1' } });
    expect(knowledge.search).toHaveBeenCalledWith('ws-1', 'Fiyat nedir?', ['d1'], 3);
    const sys = anthropic.complete.mock.calls[0][0].system;
    expect(sys).toContain('tr');
    expect(sys).toContain('Satışçı');
  });

  it('tolerant parse: strips ```json fences', async () => {
    const { anthropic, svc } = makeDeps();
    anthropic.complete.mockResolvedValue({ text: '```json\n{"suggestions":["a"],"summary":"s"}\n```' });

    const r = await svc.suggest('ws-1', null, TRANSCRIPT);
    expect(r.suggestions).toEqual(['a']);
    expect(r.summary).toBe('s');
  });

  it('tolerant parse: non-JSON falls back to {suggestions:[text], summary:""}', async () => {
    const { anthropic, svc } = makeDeps();
    anthropic.complete.mockResolvedValue({ text: 'just say hello' });

    const r = await svc.suggest('ws-1', null, TRANSCRIPT);
    expect(r.suggestions).toEqual(['just say hello']);
    expect(r.summary).toBe('');
  });

  it('refunds the credit when Claude throws', async () => {
    const { anthropic, credits, svc } = makeDeps();
    anthropic.complete.mockRejectedValue(new Error('boom'));

    await expect(svc.suggest('ws-1', 'agent-1', TRANSCRIPT)).rejects.toThrow('boom');
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 1);
    expect(credits.refund).toHaveBeenCalledWith('ws-1', 1);
  });
});
