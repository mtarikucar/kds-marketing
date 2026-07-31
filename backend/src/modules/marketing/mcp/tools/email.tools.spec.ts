import { McpToolRegistry } from '../mcp-tool-registry';
import { registerEmailTools } from './email.tools';

const ctx = { workspaceId: 'ws1', grantedScopes: ['campaigns.send'] };

function deps(overrides: { launch?: jest.Mock } = {}) {
  const templates = { list: jest.fn().mockResolvedValue([{ id: 't1', name: 'Welcome' }]) };
  const campaigns = {
    create: jest.fn().mockResolvedValue({ id: 'cmp1', status: 'DRAFT' }),
    launch: overrides.launch ?? jest.fn().mockResolvedValue({ message: 'Campaign launched', recipients: 1 }),
    remove: jest.fn().mockResolvedValue({ ok: true }),
  };
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { campaigns: true } }) };
  const registry = new McpToolRegistry();
  registerEmailTools(registry, {
    templates: templates as never,
    campaigns: campaigns as never,
    entitlements: entitlements as never,
  });
  return { registry, templates, campaigns, entitlements };
}

describe('jeeta.list_email_templates', () => {
  it('lists the workspace templates behind the campaigns feature gate', async () => {
    const { registry, templates, entitlements } = deps();
    const out = await registry.get('jeeta.list_email_templates')!.handler(ctx, {});
    expect(entitlements.getEffective).toHaveBeenCalledWith('ws1');
    expect(templates.list).toHaveBeenCalledWith('ws1');
    expect(out).toEqual([{ id: 't1', name: 'Welcome' }]);
  });
});

describe('jeeta.send_email — compliance by construction', () => {
  /**
   * The whole design decision in one assertion. `EmailService.sendPlainEmail`
   * would have been one line, and it enforces no opt-out, adds no unsubscribe
   * footer and ignores hard bounces. Sending as a one-recipient campaign is
   * what buys all three, so the shape of the call it makes is the contract.
   */
  it('sends as a ONE-RECIPIENT email campaign, not a raw SMTP call', async () => {
    const { registry, campaigns } = deps();
    await registry.get('jeeta.send_email')!.handler(ctx, {
      leadId: 'lead-9',
      subject: 'Your quote',
      body: 'Here it is.',
    });

    expect(campaigns.create).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        channel: 'EMAIL',
        subject: 'Your quote',
        body: 'Here it is.',
        // Exactly one lead. `buildAudienceWhere` ANDs this onto the opt-out,
        // deliverability and tombstone guards it always applies.
        audienceFilter: [{ field: 'id', op: 'eq', value: 'lead-9' }],
      }),
    );
    expect(campaigns.launch).toHaveBeenCalledWith('ws1', 'cmp1');
  });

  it('names the campaign so a human can spot a 1:1 agent send in the campaign list', async () => {
    const { registry, campaigns } = deps();
    await registry.get('jeeta.send_email')!.handler(ctx, { leadId: 'l1', subject: 'Your quote', body: 'b' });
    expect(campaigns.create.mock.calls[0][1].name).toContain('Your quote');
    expect(campaigns.create.mock.calls[0][1].name.length).toBeLessThanOrEqual(120);
  });

  /**
   * `launch()` refuses with "Audience is empty (no opted-in, reachable leads
   * match)" when the lead has opted out, hard-bounced, been soft-deleted or
   * merged. THAT refusal is the consent check — it must reach the caller
   * unchanged, and it must not leave an orphan DRAFT campaign behind.
   */
  it('surfaces the audience refusal and cleans up the draft', async () => {
    const launch = jest.fn().mockRejectedValue(new Error('Audience is empty (no opted-in, reachable leads match)'));
    const { registry, campaigns } = deps({ launch });

    await expect(
      registry.get('jeeta.send_email')!.handler(ctx, { leadId: 'opted-out', subject: 's', body: 'b' }),
    ).rejects.toThrow(/audience is empty/i);

    expect(campaigns.remove).toHaveBeenCalledWith('ws1', 'cmp1');
  });

  it('still reports the original failure if the cleanup itself fails', async () => {
    const launch = jest.fn().mockRejectedValue(new Error('Audience is empty'));
    const { registry, campaigns } = deps({ launch });
    campaigns.remove.mockRejectedValue(new Error('db down'));

    await expect(
      registry.get('jeeta.send_email')!.handler(ctx, { leadId: 'l1', subject: 's', body: 'b' }),
    ).rejects.toThrow(/audience is empty/i);
  });

  it('is approval-gated and dedupes on the lead it would email', () => {
    const { registry } = deps();
    const tool = registry.get('jeeta.send_email')!;
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('SEND');
    expect(tool.scopes).toEqual(['campaigns.send']);
    expect(tool.resourceType).toBe('lead');
    expect(tool.resourceIdFrom!({ leadId: 'lead-9' })).toBe('lead-9');
  });

  it('takes no raw email address — the address always comes from the lead record', () => {
    const { registry } = deps();
    const schema = registry.get('jeeta.send_email')!.inputSchema;
    expect(schema.safeParse({ to: 'x@y.com', subject: 's', body: 'b' }).success).toBe(false);
    expect(schema.safeParse({ leadId: 'l1', subject: 's', body: 'b' }).success).toBe(true);
  });
});
