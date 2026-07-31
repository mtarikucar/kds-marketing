import { BadRequestException } from '@nestjs/common';
import { MCP_NON_REP_PRINCIPAL } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerLeadsWriteTools } from './leads-write.tools';

const SENTINEL = { id: 'sys-1', workspaceId: 'ws-a', role: 'SYSTEM' };

function setup() {
  const registry = new McpToolRegistry();
  const leads = {
    create: jest.fn().mockResolvedValue({ id: 'l1' }),
    update: jest.fn().mockResolvedValue({ id: 'l1' }),
    updateStatus: jest.fn().mockResolvedValue({ id: 'l1' }),
    assign: jest.fn().mockResolvedValue({ id: 'l1' }),
  };
  const activities = { create: jest.fn().mockResolvedValue({ id: 'a1' }) };
  const principals = {
    resolve: jest.fn().mockResolvedValue(SENTINEL),
    assertActiveMember: jest.fn().mockResolvedValue({ id: 'u2', role: 'REP' }),
  };
  registerLeadsWriteTools(registry, { leads, activities, principals } as never);
  return { registry, leads, activities, principals };
}

const KEY_CTX = { workspaceId: 'ws-a', grantedScopes: [] };
const OAUTH_CTX = { workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' };

describe('leads write MCP tools — registration metadata', () => {
  it.each([
    ['jeeta.create_lead', ['leads.write']],
    ['jeeta.update_lead', ['leads.write']],
    ['jeeta.set_lead_status', ['leads.write']],
    ['jeeta.add_lead_note', ['leads.write']],
    // Mirrors PATCH /marketing/leads/:id/assign — @RequirePermission('leads.manage').
    ['jeeta.assign_lead', ['leads.manage']],
  ])('registers %s as WRITE with scopes %p and no approval gate', (name, scopes) => {
    const { registry } = setup();
    const tool = registry.get(name)!;
    expect(tool).toBeDefined();
    expect(tool.risk).toBe('WRITE');
    expect(tool.scopes).toEqual(scopes);
    // Spec §4: WRITE runs in AUTONOMOUS mode; only SPEND/DESTRUCTIVE are
    // always-approve. None of D1 reaches a customer or moves money.
    expect(tool.requiresApproval).toBe(false);
    expect(tool.inputSchema).toBeDefined();
  });

  it('rejects unknown arguments (registry-wide strict mode) instead of silently dropping them', () => {
    const { registry } = setup();
    expect(() =>
      (registry.get('jeeta.set_lead_status')!.inputSchema as { parse: (v: unknown) => unknown }).parse({
        leadId: 'l1',
        status: 'CONTACTED',
        typo: 1,
      }),
    ).toThrow();
  });
});

describe('jeeta.create_lead', () => {
  it('creates through MarketingLeadsService (dedup + auto-assign + custom-field validation) as the resolved actor', async () => {
    const { registry, leads, principals } = setup();
    await registry.get('jeeta.create_lead')!.handler(KEY_CTX, {
      businessName: 'Acme',
      contactPerson: 'Ali',
      businessType: 'RESTAURANT',
      source: 'REFERRAL',
      email: 'ali@acme.com',
    });
    expect(principals.resolve).toHaveBeenCalledWith(KEY_CTX);
    expect(leads.create).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ businessName: 'Acme', email: 'ali@acme.com' }),
      'sys-1',
      'SYSTEM',
    );
  });

  it('never attributes a lead to the read-only placeholder principal', async () => {
    const { registry, leads } = setup();
    await registry.get('jeeta.create_lead')!.handler(KEY_CTX, {
      businessName: 'Acme',
      contactPerson: 'Ali',
      businessType: 'RESTAURANT',
      source: 'REFERRAL',
    });
    expect(leads.create).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      MCP_NON_REP_PRINCIPAL.userId,
      expect.anything(),
    );
  });

  it('acts as the REAL user (and their live role) on an OAuth session', async () => {
    const { registry, leads, principals } = setup();
    principals.resolve.mockResolvedValue({ id: 'u9', workspaceId: 'ws-a', role: 'REP' });
    await registry.get('jeeta.create_lead')!.handler(OAUTH_CTX, {
      businessName: 'Acme',
      contactPerson: 'Ali',
      businessType: 'RESTAURANT',
      source: 'REFERRAL',
    });
    expect(leads.create).toHaveBeenCalledWith('ws-a', expect.anything(), 'u9', 'REP');
  });

  it('validates an explicit assignee is an active member of the CALLER workspace', async () => {
    const { registry, principals } = setup();
    await registry.get('jeeta.create_lead')!.handler(KEY_CTX, {
      businessName: 'Acme',
      contactPerson: 'Ali',
      businessType: 'RESTAURANT',
      source: 'REFERRAL',
      assignedToId: 'u2',
    });
    expect(principals.assertActiveMember).toHaveBeenCalledWith('ws-a', 'u2');
  });

  it('refuses the whole create when the assignee belongs to another workspace', async () => {
    const { registry, principals, leads } = setup();
    principals.assertActiveMember.mockRejectedValue(new BadRequestException('nope'));
    await expect(
      registry.get('jeeta.create_lead')!.handler(KEY_CTX, {
        businessName: 'Acme',
        contactPerson: 'Ali',
        businessType: 'RESTAURANT',
        source: 'REFERRAL',
        assignedToId: 'u-foreign',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(leads.create).not.toHaveBeenCalled();
  });
});

describe('jeeta.update_lead / jeeta.set_lead_status', () => {
  it('passes the lead id separately from the patch body and scopes to the caller workspace', async () => {
    const { registry, leads } = setup();
    await registry.get('jeeta.update_lead')!.handler(KEY_CTX, { leadId: 'l1', city: 'İzmir' });
    expect(leads.update).toHaveBeenCalledWith(
      'ws-a',
      'l1',
      expect.objectContaining({ city: 'İzmir' }),
      'sys-1',
      'SYSTEM',
    );
    // `leadId` is a routing argument, not a column — it must not leak into the patch.
    expect(leads.update.mock.calls[0][2]).not.toHaveProperty('leadId');
  });

  it('routes a stage change through updateStatus so transition rules, TOCTOU claim and the timeline row all apply', async () => {
    const { registry, leads } = setup();
    await registry
      .get('jeeta.set_lead_status')!
      .handler(KEY_CTX, { leadId: 'l1', status: 'LOST', lostReason: 'budget' });
    expect(leads.updateStatus).toHaveBeenCalledWith('ws-a', 'l1', 'LOST', 'budget', 'sys-1', 'SYSTEM');
  });

  it('does not offer WON on set_lead_status — conversion owns that transition', () => {
    const { registry } = setup();
    expect(() =>
      (registry.get('jeeta.set_lead_status')!.inputSchema as { parse: (v: unknown) => unknown }).parse({
        leadId: 'l1',
        status: 'WON',
      }),
    ).toThrow();
  });
});

describe('jeeta.add_lead_note', () => {
  it('writes a NOTE activity attributed to the resolved actor', async () => {
    const { registry, activities } = setup();
    await registry
      .get('jeeta.add_lead_note')!
      .handler(KEY_CTX, { leadId: 'l1', title: 'Called back', description: 'wants a demo' });
    expect(activities.create).toHaveBeenCalledWith(
      'ws-a',
      'l1',
      expect.objectContaining({ type: 'NOTE', title: 'Called back', description: 'wants a demo' }),
      'sys-1',
      'SYSTEM',
    );
  });

  it('supports the other timeline kinds (a logged call, a visit) without inventing new storage', async () => {
    const { registry, activities } = setup();
    await registry
      .get('jeeta.add_lead_note')!
      .handler(KEY_CTX, { leadId: 'l1', title: 'Demo call', type: 'CALL', outcome: 'POSITIVE', duration: 12 });
    expect(activities.create).toHaveBeenCalledWith(
      'ws-a',
      'l1',
      expect.objectContaining({ type: 'CALL', outcome: 'POSITIVE', duration: 12 }),
      'sys-1',
      'SYSTEM',
    );
  });
});

describe('jeeta.assign_lead', () => {
  it('validates the target is an ACTIVE member of the caller workspace before assigning', async () => {
    const { registry, leads, principals } = setup();
    await registry.get('jeeta.assign_lead')!.handler(KEY_CTX, { leadId: 'l1', assignedToId: 'u2' });
    expect(principals.assertActiveMember).toHaveBeenCalledWith('ws-a', 'u2');
    expect(leads.assign).toHaveBeenCalledWith('ws-a', 'l1', 'u2', 'sys-1');
  });

  it('refuses to assign to a user outside the workspace', async () => {
    const { registry, leads, principals } = setup();
    principals.assertActiveMember.mockRejectedValue(new BadRequestException('nope'));
    await expect(
      registry.get('jeeta.assign_lead')!.handler(KEY_CTX, { leadId: 'l1', assignedToId: 'u-foreign' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(leads.assign).not.toHaveBeenCalled();
  });

  it('unassigns (back to the pool) on an explicit null without a membership lookup', async () => {
    const { registry, leads, principals } = setup();
    await registry.get('jeeta.assign_lead')!.handler(KEY_CTX, { leadId: 'l1', assignedToId: null });
    expect(principals.assertActiveMember).not.toHaveBeenCalled();
    expect(leads.assign).toHaveBeenCalledWith('ws-a', 'l1', null, 'sys-1');
  });
});
