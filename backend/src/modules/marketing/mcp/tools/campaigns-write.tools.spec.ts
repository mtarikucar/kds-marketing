import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCampaignWriteTools } from './campaigns-write.tools';

const ctx = { workspaceId: 'ws1', grantedScopes: ['campaigns.write'] };

function deps() {
  const campaigns = { create: jest.fn().mockResolvedValue({ id: 'cmp1', status: 'DRAFT' }) };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { campaigns: true } }) };
  const registry = new McpToolRegistry();
  registerCampaignWriteTools(registry, { campaigns: campaigns as never, entitlements: entitlements as never });
  return { registry, campaigns, entitlements };
}

describe('jeeta.create_campaign', () => {
  it('creates a DRAFT and never launches', async () => {
    const { registry, campaigns } = deps();
    const out = await registry.get('jeeta.create_campaign')!.handler(ctx, {
      name: 'Spring promo',
      channel: 'SMS',
      body: 'Hello',
      audienceFilter: [{ field: 'city', op: 'eq', value: 'Istanbul' }],
      iysMessageType: 'TICARI',
    });
    expect(campaigns.create).toHaveBeenCalledWith('ws1', {
      name: 'Spring promo',
      channel: 'SMS',
      body: 'Hello',
      audienceFilter: [{ field: 'city', op: 'eq', value: 'Istanbul' }],
      iysMessageType: 'TICARI',
    });
    expect(out).toMatchObject({ status: 'DRAFT' });
    // The only verb this tool has access to is `create` — launching is
    // jeeta.set_campaign_status's job, and that one is approval-gated.
    expect(Object.keys(campaigns)).toEqual(['create']);
  });

  /**
   * `buildAudienceWhere` DROPS an unrecognised field silently, so a free-text
   * `field` would let `{field: 'tag', op: 'eq', value: 'vip'}` produce a
   * campaign aimed at EVERY opted-in lead while reading as a targeted one. The
   * enum turns that into a visible schema error instead.
   */
  it('rejects an audience field the service would silently drop', () => {
    const { registry } = deps();
    const schema = registry.get('jeeta.create_campaign')!.inputSchema;
    expect(
      schema.safeParse({ name: 'n', channel: 'EMAIL', body: 'b', audienceFilter: [{ field: 'tag', op: 'eq', value: 'vip' }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ name: 'n', channel: 'EMAIL', body: 'b', audienceFilter: [{ field: 'city', op: 'eq', value: 'Izmir' }] })
        .success,
    ).toBe(true);
  });

  it('routes VOICE to its own tool rather than accepting it here', () => {
    const { registry } = deps();
    const schema = registry.get('jeeta.create_campaign')!.inputSchema;
    expect(schema.safeParse({ name: 'n', channel: 'VOICE', body: 'b' }).success).toBe(false);
  });

  it('is an unattended WRITE — a draft reaches nobody', () => {
    const { registry } = deps();
    const tool = registry.get('jeeta.create_campaign')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
    expect(tool.scopes).toEqual(['campaigns.write']);
  });

  it('refuses without the campaigns package feature', async () => {
    const { registry, entitlements, campaigns } = deps();
    entitlements.getEffective.mockResolvedValue({ features: {} });
    await expect(
      registry.get('jeeta.create_campaign')!.handler(ctx, { name: 'n', channel: 'EMAIL', body: 'b' }),
    ).rejects.toMatchObject({ response: { code: 'FEATURE_NOT_IN_PACKAGE' } });
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  /**
   * The spec's §5 D3 line asks for "SMS kampanyası oluştur & gönder". The send
   * half already exists: `jeeta.set_campaign_status(status: 'SENDING')`
   * dispatches to `CampaignsService.launch()`/`resume()` and is registered
   * `requiresApproval: true` / `approvalKind: 'PUBLISH'`. A separate
   * `jeeta.send_campaign` would be a second name for the same guarded
   * transition — and a second approval card for the same act — so it is
   * deliberately absent. This test exists so that absence reads as a decision.
   */
  it('registers no separate send verb (set_campaign_status is the send)', () => {
    const { registry } = deps();
    expect(registry.has('jeeta.send_campaign')).toBe(false);
  });
});
