import { BadRequestException } from '@nestjs/common';
import { MCP_NON_REP_PRINCIPAL } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerPipelineTools } from './pipeline.tools';

const SENTINEL = {
  id: 'sys-1',
  workspaceId: 'ws-a',
  email: 'research+ws-a@system.internal',
  firstName: 'AI',
  lastName: 'Research',
  role: 'SYSTEM',
  status: 'ACTIVE',
};

const PIPELINE = {
  id: 'p1',
  name: 'Sales',
  stages: [
    { id: 's1', name: 'Discovery', position: 0, isWon: false, isLost: false },
    { id: 's2', name: 'Proposal', position: 1, isWon: false, isLost: false },
  ],
};

function setup() {
  const registry = new McpToolRegistry();
  const opportunities = {
    list: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    create: jest.fn().mockResolvedValue({ id: 'o1' }),
    move: jest.fn().mockResolvedValue({ id: 'o1' }),
    get: jest.fn().mockResolvedValue({ id: 'o1', pipelineId: 'p1', stageId: 's1' }),
  };
  const pipelines = {
    list: jest.fn().mockResolvedValue([PIPELINE]),
    get: jest.fn().mockResolvedValue(PIPELINE),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue(SENTINEL),
    assertActiveMember: jest.fn().mockResolvedValue({ id: 'u2', role: 'REP' }),
  };
  registerPipelineTools(registry, { opportunities, pipelines, principals } as never);
  return { registry, opportunities, pipelines, principals };
}

const KEY_CTX = { workspaceId: 'ws-a', grantedScopes: [] };

describe('pipeline MCP tools — registration metadata', () => {
  it.each([
    ['jeeta.list_pipelines', ['leads.read'], 'READ'],
    ['jeeta.list_opportunities', ['leads.read'], 'READ'],
    ['jeeta.create_opportunity', ['leads.write'], 'WRITE'],
    ['jeeta.move_opportunity_stage', ['leads.write'], 'WRITE'],
  ])('registers %s with scopes %p as %s and no approval gate', (name, scopes, risk) => {
    const { registry } = setup();
    const tool = registry.get(name)!;
    expect(tool).toBeDefined();
    expect(tool.scopes).toEqual(scopes);
    expect(tool.risk).toBe(risk);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.inputSchema).toBeDefined();
  });
});

describe('jeeta.list_pipelines', () => {
  it('lists the caller workspace pipelines with their stages (the ids move_opportunity_stage needs)', async () => {
    const { registry, pipelines } = setup();
    await registry.get('jeeta.list_pipelines')!.handler(KEY_CTX, {});
    expect(pipelines.list).toHaveBeenCalledWith('ws-a');
  });
});

describe('jeeta.list_opportunities', () => {
  it('passes a real, workspace-local principal so REP row-level narrowing works', async () => {
    const { registry, opportunities, principals } = setup();
    await registry.get('jeeta.list_opportunities')!.handler(KEY_CTX, { status: 'OPEN' });
    expect(principals.resolve).toHaveBeenCalledWith(KEY_CTX);
    expect(opportunities.list).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ status: 'OPEN' }),
      expect.objectContaining({ id: 'sys-1', workspaceId: 'ws-a', role: 'SYSTEM' }),
    );
  });

  it('never hands the opportunities service the synthetic read-only placeholder id', async () => {
    const { registry, opportunities } = setup();
    await registry.get('jeeta.list_opportunities')!.handler(KEY_CTX, {});
    expect(opportunities.list.mock.calls[0][2].id).not.toBe(MCP_NON_REP_PRINCIPAL.userId);
  });

  it('narrows to the caller on an OAuth REP session', async () => {
    const { registry, opportunities, principals } = setup();
    principals.resolve.mockResolvedValue({ ...SENTINEL, id: 'u9', role: 'REP' });
    await registry
      .get('jeeta.list_opportunities')!
      .handler({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' }, {});
    expect(opportunities.list.mock.calls[0][2]).toMatchObject({ id: 'u9', role: 'REP' });
  });
});

describe('jeeta.create_opportunity', () => {
  it('creates in the caller workspace as the resolved actor', async () => {
    const { registry, opportunities } = setup();
    await registry
      .get('jeeta.create_opportunity')!
      .handler(KEY_CTX, { name: 'Acme renewal', value: 5000, currency: 'TRY' });
    expect(opportunities.create).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ name: 'Acme renewal', value: 5000 }),
      expect.objectContaining({ id: 'sys-1' }),
    );
  });

  it('validates an explicit owner is an active member of the caller workspace', async () => {
    const { registry, principals, opportunities } = setup();
    principals.assertActiveMember.mockRejectedValue(new BadRequestException('nope'));
    await expect(
      registry.get('jeeta.create_opportunity')!.handler(KEY_CTX, { name: 'x', assignedToId: 'u-foreign' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(opportunities.create).not.toHaveBeenCalled();
  });
});

describe('jeeta.move_opportunity_stage', () => {
  it('moves by explicit stage id', async () => {
    const { registry, opportunities } = setup();
    await registry
      .get('jeeta.move_opportunity_stage')!
      .handler(KEY_CTX, { opportunityId: 'o1', stageId: 's2' });
    expect(opportunities.move).toHaveBeenCalledWith(
      'ws-a',
      'o1',
      { stageId: 's2', position: undefined },
      expect.objectContaining({ id: 'sys-1' }),
    );
  });

  it("resolves a stage NAME against the opportunity's own pipeline, in the caller workspace", async () => {
    const { registry, opportunities, pipelines } = setup();
    await registry
      .get('jeeta.move_opportunity_stage')!
      .handler(KEY_CTX, { opportunityId: 'o1', stageName: 'proposal' });
    expect(opportunities.get).toHaveBeenCalledWith('ws-a', 'o1', expect.objectContaining({ id: 'sys-1' }));
    expect(pipelines.get).toHaveBeenCalledWith('ws-a', 'p1');
    expect(opportunities.move.mock.calls[0][2]).toEqual({ stageId: 's2', position: undefined });
  });

  it('refuses an unknown stage name instead of guessing a stage', async () => {
    const { registry, opportunities } = setup();
    await expect(
      registry
        .get('jeeta.move_opportunity_stage')!
        .handler(KEY_CTX, { opportunityId: 'o1', stageName: 'Nonexistent' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(opportunities.move).not.toHaveBeenCalled();
  });

  it('requires exactly one of stageId / stageName', async () => {
    const { registry } = setup();
    await expect(
      registry.get('jeeta.move_opportunity_stage')!.handler(KEY_CTX, { opportunityId: 'o1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
