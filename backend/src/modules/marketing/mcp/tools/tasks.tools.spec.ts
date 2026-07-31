import { BadRequestException } from '@nestjs/common';
import { MCP_NON_REP_PRINCIPAL } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerTasksTools } from './tasks.tools';

const SENTINEL = { id: 'sys-1', workspaceId: 'ws-a', role: 'SYSTEM' };

function setup() {
  const registry = new McpToolRegistry();
  const tasks = {
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    create: jest.fn().mockResolvedValue({ id: 't1' }),
    complete: jest.fn().mockResolvedValue({ id: 't1' }),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue(SENTINEL),
    assertActiveMember: jest.fn().mockResolvedValue({ id: 'u2', role: 'REP' }),
  };
  registerTasksTools(registry, { tasks, principals } as never);
  return { registry, tasks, principals };
}

const KEY_CTX = { workspaceId: 'ws-a', grantedScopes: [] };
const OAUTH_REP_CTX = { workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' };

describe('tasks MCP tools — registration metadata', () => {
  it.each([
    ['jeeta.list_tasks', ['tasks.read'], 'READ'],
    ['jeeta.create_task', ['tasks.write'], 'WRITE'],
    ['jeeta.complete_task', ['tasks.write'], 'WRITE'],
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

describe('jeeta.list_tasks', () => {
  it('scopes to the caller workspace and uses the read-only placeholder on an API-key session', async () => {
    const { registry, tasks, principals } = setup();
    await registry.get('jeeta.list_tasks')!.handler(KEY_CTX, { status: 'PENDING' });
    expect(tasks.findAll).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ status: 'PENDING' }),
      MCP_NON_REP_PRINCIPAL.userId,
      MCP_NON_REP_PRINCIPAL.role,
    );
    // A read needs no FK-safe identity, so it must not cost a principal lookup.
    expect(principals.resolve).not.toHaveBeenCalled();
  });

  it('narrows to the caller on an OAuth REP session, exactly as the UI does', async () => {
    const { registry, tasks } = setup();
    await registry.get('jeeta.list_tasks')!.handler(OAUTH_REP_CTX, {});
    expect(tasks.findAll).toHaveBeenCalledWith('ws-a', expect.anything(), 'u9', 'REP');
  });
});

describe('jeeta.create_task', () => {
  it('creates as the resolved actor, scoped to the caller workspace', async () => {
    const { registry, tasks } = setup();
    await registry.get('jeeta.create_task')!.handler(OAUTH_REP_CTX, {
      title: 'Call Acme',
      type: 'CALL',
      dueDate: '2026-08-05',
      assignedToId: 'u9',
    });
    expect(tasks.create).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ title: 'Call Acme', type: 'CALL', assignedToId: 'u9' }),
      'sys-1',
    );
  });

  it('validates the assignee is an ACTIVE member — the service only checks in-workspace, not active', async () => {
    const { registry, principals } = setup();
    await registry
      .get('jeeta.create_task')!
      .handler(OAUTH_REP_CTX, { title: 'x', type: 'CALL', dueDate: '2026-08-05', assignedToId: 'u2' });
    expect(principals.assertActiveMember).toHaveBeenCalledWith('ws-a', 'u2');
  });

  it('refuses the create when the assignee is deactivated or from another workspace', async () => {
    const { registry, tasks, principals } = setup();
    principals.assertActiveMember.mockRejectedValue(new BadRequestException('nope'));
    await expect(
      registry
        .get('jeeta.create_task')!
        .handler(OAUTH_REP_CTX, { title: 'x', type: 'CALL', dueDate: '2026-08-05', assignedToId: 'u-foreign' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  /**
   * MarketingTasksService.create defaults `assignedToId` to the actor. On an
   * API-key session the actor is the automation principal, which can never log
   * in — the task would land in a queue no human ever opens. Refuse instead.
   */
  it('requires an explicit assignee on an API-key session rather than parking work on the automation principal', async () => {
    const { registry, tasks } = setup();
    await expect(
      registry.get('jeeta.create_task')!.handler(KEY_CTX, { title: 'x', type: 'CALL', dueDate: '2026-08-05' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('defaults the assignee to the human caller on an OAuth session', async () => {
    const { registry, tasks, principals } = setup();
    principals.resolve.mockResolvedValue({ id: 'u9', workspaceId: 'ws-a', role: 'REP' });
    await registry
      .get('jeeta.create_task')!
      .handler(OAUTH_REP_CTX, { title: 'x', type: 'CALL', dueDate: '2026-08-05' });
    expect(tasks.create).toHaveBeenCalledWith('ws-a', expect.anything(), 'u9');
  });
});

describe('jeeta.complete_task', () => {
  it('completes as the resolved actor so the REP ownership rule still applies', async () => {
    const { registry, tasks, principals } = setup();
    principals.resolve.mockResolvedValue({ id: 'u9', workspaceId: 'ws-a', role: 'REP' });
    await registry.get('jeeta.complete_task')!.handler(OAUTH_REP_CTX, { taskId: 't1' });
    expect(tasks.complete).toHaveBeenCalledWith('ws-a', 't1', 'u9', 'REP');
  });

  it('never completes with the read-only placeholder identity', async () => {
    const { registry, tasks } = setup();
    await registry.get('jeeta.complete_task')!.handler(KEY_CTX, { taskId: 't1' });
    expect(tasks.complete).toHaveBeenCalledWith('ws-a', 't1', 'sys-1', 'SYSTEM');
    expect(tasks.complete).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      MCP_NON_REP_PRINCIPAL.userId,
      expect.anything(),
    );
  });
});
