import { ForbiddenException } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerSocialCampaignTools } from './social-campaigns.tools';

function build(features: Record<string, boolean> = { socialCampaigns: true }) {
  const registry = new McpToolRegistry();
  const campaigns = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'sc1', status: 'DRAFT' }),
    get: jest.fn().mockResolvedValue({ id: 'sc1' }),
    listItems: jest.fn().mockResolvedValue([]),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue({ id: 'sys-1', workspaceId: 'ws1', role: 'SYSTEM' }),
    assertActiveMember: jest.fn(),
  };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features }) };
  registerSocialCampaignTools(registry, {
    socialCampaigns: campaigns as never,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, campaigns, principals, entitlements };
}

const ctx = () => ({ workspaceId: 'ws1', grantedScopes: [] });

const VALID = {
  name: 'Summer menu',
  brief: { audience: 'families' },
  automationMode: 'APPROVAL',
  planningMode: 'AI_PROPOSE',
  cadence: { daysOfWeek: [1, 4], timeOfDay: '09:30' },
  startDate: '2026-08-01T00:00:00.000Z',
  targetAccountIds: ['a1'],
  mediaKinds: ['IMAGE'],
};

describe('Faz 5 D2 — social campaigns', () => {
  it('jeeta.list_social_campaigns is a plain read behind the socialCampaigns entitlement', async () => {
    const { registry, campaigns } = build();
    const tool = registry.get('jeeta.list_social_campaigns')!;
    expect(tool.risk).toBe('READ');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['campaigns.read']);
    await tool.handler(ctx(), {});
    expect(campaigns.list).toHaveBeenCalledWith('ws1');
  });

  it('jeeta.create_social_campaign is a WRITE — create leaves the engine DRAFT/inert', () => {
    const tool = build().registry.get('jeeta.create_social_campaign')!;
    // SocialCampaignsService.create() hardcodes status DRAFT and schedules no
    // job; only activate() (deliberately NOT exposed in D2) starts publishing.
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['campaigns.write']);
  });

  it('does NOT expose an activate tool — turning the engine on stays a panel decision', () => {
    const { registry } = build();
    const names = registry.list(['campaigns.read', 'campaigns.write', 'campaigns.send']).map((t) => t.name);
    expect(names).not.toContain('jeeta.activate_social_campaign');
    expect(names.sort()).toEqual(['jeeta.create_social_campaign', 'jeeta.list_social_campaigns'].sort());
  });

  it('creates with parsed dates and the resolved principal as author', async () => {
    const { registry, campaigns, principals } = build();
    await registry.get('jeeta.create_social_campaign')!.handler(ctx(), {
      ...VALID,
      endDate: '2026-09-01T00:00:00.000Z',
    });
    expect(principals.resolve).toHaveBeenCalled();
    expect(campaigns.create).toHaveBeenCalledWith('ws1', {
      name: 'Summer menu',
      brief: { audience: 'families' },
      automationMode: 'APPROVAL',
      planningMode: 'AI_PROPOSE',
      cadence: { daysOfWeek: [1, 4], timeOfDay: '09:30' },
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-09-01T00:00:00.000Z'),
      targetAccountIds: ['a1'],
      mediaKinds: ['IMAGE'],
      createdById: 'sys-1',
    });
  });

  it('refuses an unparseable startDate', async () => {
    const { registry, campaigns } = build();
    await expect(
      registry.get('jeeta.create_social_campaign')!.handler(ctx(), { ...VALID, startDate: 'august' }),
    ).rejects.toThrow(/startDate/i);
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('refuses cleanly on a package without socialCampaigns, before touching the service', async () => {
    const { registry, campaigns } = build({ socialCampaigns: false });
    const err = await registry
      .get('jeeta.create_social_campaign')!
      .handler(ctx(), VALID)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'FEATURE_NOT_IN_PACKAGE', feature: 'socialCampaigns' }),
    );
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('gates the read tool on the entitlement too', async () => {
    const { registry, campaigns } = build({ socialCampaigns: false });
    await expect(registry.get('jeeta.list_social_campaigns')!.handler(ctx(), {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(campaigns.list).not.toHaveBeenCalled();
  });
});
