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
    reopen: jest.fn().mockResolvedValue({ id: 'l1', status: 'NEW' }),
    assign: jest.fn().mockResolvedValue({ id: 'l1' }),
  };
  const activities = { create: jest.fn().mockResolvedValue({ id: 'a1' }) };
  const principals = {
    resolve: jest.fn().mockResolvedValue(SENTINEL),
    assertActiveMember: jest.fn().mockResolvedValue({ id: 'u2', role: 'REP' }),
  };
  const dedupe = {
    findDuplicates: jest.fn().mockResolvedValue([]),
    merge: jest.fn().mockResolvedValue({ canonicalId: 'l1', merged: 2 }),
  };
  registerLeadsWriteTools(registry, { leads, activities, principals, dedupe } as never);
  return { registry, leads, activities, principals, dedupe };
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
    // Manager-tier for the same reason as assign: rewinding a stage rewrites
    // what the funnel reports, so it must not ride on a plain write scope.
    ['jeeta.reopen_lead', ['leads.manage']],
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

describe('jeeta.reopen_lead', () => {
  it('sends the lead back to NEW with the reason, as the resolved actor', async () => {
    const { registry, leads } = setup();
    await registry
      .get('jeeta.reopen_lead')!
      .handler(KEY_CTX, { leadId: 'l1', reason: 'demo was never held — stage set in error' });
    expect(leads.reopen).toHaveBeenCalledWith(
      'ws-a',
      'l1',
      'demo was never held — stage set in error',
      'sys-1',
      'SYSTEM',
    );
  });

  it('will not accept a throwaway reason', () => {
    const { registry } = setup();
    const schema = registry.get('jeeta.reopen_lead')!.inputSchema as {
      parse: (v: unknown) => unknown;
    };
    // A rewind with no explanation reads the same as someone quietly resetting
    // the funnel, so the reason is the point of the tool, not decoration.
    expect(() => schema.parse({ leadId: 'l1', reason: 'oops' })).toThrow();
    expect(() => schema.parse({ leadId: 'l1' })).toThrow();
  });

  it('takes no target status — NEW is the only destination', () => {
    const { registry } = setup();
    expect(() =>
      (registry.get('jeeta.reopen_lead')!.inputSchema as { parse: (v: unknown) => unknown }).parse({
        leadId: 'l1',
        reason: 'stage was entered in error',
        status: 'CONTACTED',
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


/**
 * Deduplication was implemented, tested and wired to REST — and reachable from
 * nowhere. The panel's only "duplicates" surface is the import wizard's
 * skip/update POLICY, and the catalogue had no dedupe tool, so seven inbound
 * creation paths could pile up duplicates a workspace could not consolidate.
 */
describe('lead deduplication', () => {
  it('reports an empty result as a real answer, not a bare empty list', async () => {
    const { registry, dedupe } = setup();
    const out = (await registry.get('jeeta.list_duplicate_leads')!.handler(KEY_CTX, {})) as {
      clusters: unknown[];
      message: string;
    };
    expect(dedupe.findDuplicates).toHaveBeenCalledWith('ws-a');
    expect(out.clusters).toEqual([]);
    expect(out.message).toMatch(/no duplicate/i);
  });

  it('passes the caller workspace and returns the clusters for comparison', async () => {
    const { registry, dedupe } = setup();
    dedupe.findDuplicates.mockResolvedValue([
      { suggestedCanonicalId: 'l1', leads: [{ id: 'l1' }, { id: 'l2' }] },
    ]);
    const out = (await registry.get('jeeta.list_duplicate_leads')!.handler(KEY_CTX, {})) as {
      clusters: unknown[];
      message: string;
    };
    expect(out.clusters).toHaveLength(1);
    expect(out.message).toMatch(/1 possible duplicate/i);
  });

  it('merges through the shared service, scoped to the caller workspace', async () => {
    const { registry, dedupe } = setup();
    const out = (await registry.get('jeeta.merge_leads')!.handler(KEY_CTX, {
      canonicalId: 'l1',
      duplicateIds: ['l2', 'l3'],
    })) as { merged: number; requested: number; message: string };
    expect(dedupe.merge).toHaveBeenCalledWith('ws-a', 'l1', ['l2', 'l3']);
    expect(out).toMatchObject({ merged: 2, requested: 2 });
  });

  /**
   * The service silently drops ids that are already merged or belong to another
   * workspace, so a bare count would read as "all of them".
   */
  it('says so when fewer were merged than asked for', async () => {
    const { registry, dedupe } = setup();
    dedupe.merge.mockResolvedValue({ canonicalId: 'l1', merged: 1 });
    const out = (await registry.get('jeeta.merge_leads')!.handler(KEY_CTX, {
      canonicalId: 'l1',
      duplicateIds: ['l2', 'l3'],
    })) as { message: string };
    expect(out.message).toMatch(/1 of 2/);
    expect(out.message).toMatch(/already merged|not leads of this workspace/i);
  });

  /**
   * Merging rewrites a customer's history and hides rows everywhere at once, so
   * it stays behind a human even in AUTONOMOUS mode — DESTRUCTIVE is the one
   * risk class the broker never lets autonomy bypass.
   */
  it('classifies merge as DESTRUCTIVE and approval-gated, while listing stays a plain read', () => {
    const { registry } = setup();
    const merge = registry.get('jeeta.merge_leads')!;
    expect(merge.risk).toBe('DESTRUCTIVE');
    expect(merge.requiresApproval).toBe(true);
    expect(merge.scopes).toEqual(['leads.write']);

    const list = registry.get('jeeta.list_duplicate_leads')!;
    expect(list.risk).toBe('READ');
    expect(list.requiresApproval).toBe(false);
    expect(list.scopes).toEqual(['leads.read']);
  });
});
