import { AgentRunService } from './agent-run.service';

function makePrisma() {
  const create = jest.fn().mockResolvedValue({ id: 'run-1' });
  const toolCreate = jest.fn().mockResolvedValue({});
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    agentRun: { create, update, findMany: jest.fn().mockResolvedValue([]) },
    toolCallLog: { create: toolCreate },
  } as any;
  return { prisma, create, toolCreate, update };
}

describe('AgentRunService', () => {
  it('starts a run and returns its id', async () => {
    const { prisma, create } = makePrisma();
    const svc = new AgentRunService(prisma);
    const id = await svc.start('ws1', { agent: 'strategist', goal: 'plan july', input: { x: 1 } });
    expect(id).toBe('run-1');
    expect(create.mock.calls[0][0].data).toMatchObject({ workspaceId: 'ws1', agent: 'strategist', goal: 'plan july' });
  });

  it('records a tool call', async () => {
    const { prisma, toolCreate } = makePrisma();
    const svc = new AgentRunService(prisma);
    await svc.recordTool('ws1', 'run-1', { tool: 'search', args: { q: 'x' }, ok: true, latencyMs: 42 });
    expect(toolCreate.mock.calls[0][0].data).toMatchObject({ workspaceId: 'ws1', runId: 'run-1', tool: 'search', ok: true, latencyMs: 42 });
  });

  it('track() finishes DONE with output on success', async () => {
    const { prisma, update } = makePrisma();
    const svc = new AgentRunService(prisma);
    const out = await svc.track('ws1', { agent: 'copywriter' }, async () => ({ text: 'hi' }));
    expect(out).toEqual({ text: 'hi' });
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'DONE', output: { text: 'hi' } });
  });

  it('track() finishes FAILED and re-throws on error', async () => {
    const { prisma, update } = makePrisma();
    const svc = new AgentRunService(prisma);
    await expect(svc.track('ws1', { agent: 'copywriter' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(update.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', error: 'boom' });
  });
});
