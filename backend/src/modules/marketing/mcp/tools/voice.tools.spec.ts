import { McpToolRegistry } from '../mcp-tool-registry';
import { registerVoiceTools } from './voice.tools';

const ctx = { workspaceId: 'ws1', grantedScopes: ['leads.write'] };

const REACHABLE = { id: 'l1', phone: ' +905551112233 ', smsOptOut: false, deletedAt: null, mergedIntoId: null };

function deps(lead: Record<string, unknown> = REACHABLE) {
  const calls = {
    startCall: jest.fn().mockResolvedValue({ call: { id: 'c1' }, dialUri: 'tel:+905551112233', mode: 'api' }),
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  };
  const leads = { findOne: jest.fn().mockResolvedValue(lead) };
  const campaigns = { create: jest.fn().mockResolvedValue({ id: 'cmp1', status: 'DRAFT' }) };
  const principals = {
    resolve: jest.fn().mockResolvedValue({ id: 'sys-1', role: 'SYSTEM' }),
    assertActiveMember: jest.fn(),
  };
  const entitlements = {
    getEffective: jest.fn().mockResolvedValue({ features: { telephony: true, voiceCampaigns: true } }),
  };
  const registry = new McpToolRegistry();
  registerVoiceTools(registry, {
    calls: calls as never,
    leads: leads as never,
    campaigns: campaigns as never,
    principals: principals as never,
    entitlements: entitlements as never,
  });
  return { registry, calls, leads, campaigns, principals, entitlements };
}

describe('jeeta.click_to_dial — consent before the phone rings', () => {
  it('dials the number stored on the lead, attributed to a real principal', async () => {
    const { registry, calls, principals } = deps();
    const out = await registry.get('jeeta.click_to_dial')!.handler(ctx, { leadId: 'l1' });

    expect(principals.resolve).toHaveBeenCalled();
    expect(calls.startCall).toHaveBeenCalledWith('ws1', 'sys-1', {
      toPhone: '+905551112233', // trimmed
      leadId: 'l1',
    });
    expect(out).toMatchObject({ mode: 'api' });
  });

  /**
   * `SalesCallService.startCall` has NO opt-out check — correct for a rep
   * clicking "call", a legal problem for an agent dialling unattended.
   * `smsOptOut` is the product's documented voice-reachability predicate
   * (`buildAudienceWhere`'s VOICE branch and `CampaignSenderService.isOptedOut`
   * both read exactly this column), so it is what gets applied here.
   */
  it('refuses a lead who has opted out of phone contact, and never reaches the dialler', async () => {
    const { registry, calls } = deps({ ...REACHABLE, smsOptOut: true });
    await expect(registry.get('jeeta.click_to_dial')!.handler(ctx, { leadId: 'l1' })).rejects.toThrow(
      /opted out of phone contact/i,
    );
    expect(calls.startCall).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted lead', async () => {
    const { registry, calls } = deps({ ...REACHABLE, deletedAt: new Date() });
    await expect(registry.get('jeeta.click_to_dial')!.handler(ctx, { leadId: 'l1' })).rejects.toThrow(
      /deleted or merged/i,
    );
    expect(calls.startCall).not.toHaveBeenCalled();
  });

  it('refuses a merged lead (the number belongs to the surviving record)', async () => {
    const { registry, calls } = deps({ ...REACHABLE, mergedIntoId: 'l2' });
    await expect(registry.get('jeeta.click_to_dial')!.handler(ctx, { leadId: 'l1' })).rejects.toThrow(
      /deleted or merged/i,
    );
    expect(calls.startCall).not.toHaveBeenCalled();
  });

  it('refuses a lead with no number rather than dialling nothing', async () => {
    const { registry, calls } = deps({ ...REACHABLE, phone: '   ' });
    await expect(registry.get('jeeta.click_to_dial')!.handler(ctx, { leadId: 'l1' })).rejects.toThrow(
      /no phone number/i,
    );
    expect(calls.startCall).not.toHaveBeenCalled();
  });

  /**
   * The schema is half the guard: if an agent could pass a raw destination the
   * opt-out check above would be trivially bypassable by simply not naming the
   * lead it belongs to.
   */
  it('accepts no arbitrary phone number', () => {
    const { registry } = deps();
    const schema = registry.get('jeeta.click_to_dial')!.inputSchema;
    expect(schema.safeParse({ toPhone: '+905550000000' }).success).toBe(false);
    expect(schema.safeParse({ leadId: 'l1', toPhone: '+905550000000' }).success).toBe(false);
    expect(schema.safeParse({ leadId: 'l1' }).success).toBe(true);
  });

  it('is approval-gated: ringing a real person is the same class as publishing', () => {
    const { registry } = deps();
    const tool = registry.get('jeeta.click_to_dial')!;
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('SEND');
    expect(tool.resourceIdFrom!({ leadId: 'l1' })).toBe('l1');
  });
});

describe('jeeta.list_calls', () => {
  it('passes the visibility principal so a REP only ever sees their own calls', async () => {
    const { registry, calls } = deps();
    await registry
      .get('jeeta.list_calls')!
      .handler({ ...ctx, userId: 'u-rep', userRole: 'REP' }, { limit: 5 });
    expect(calls.list).toHaveBeenCalledWith('ws1', { limit: 5 }, { id: 'u-rep', role: 'REP' });
  });

  it('falls back to the declared non-REP placeholder on an API-key session', async () => {
    const { registry, calls } = deps();
    await registry.get('jeeta.list_calls')!.handler(ctx, {});
    expect(calls.list.mock.calls[0][2]).toEqual({ id: 'mcp-service-principal', role: 'MANAGER' });
  });
});

describe('jeeta.create_voice_campaign', () => {
  it('creates a DRAFT and arms nothing', async () => {
    const { registry, campaigns } = deps();
    await registry.get('jeeta.create_voice_campaign')!.handler(ctx, {
      name: 'Reminder wave',
      body: 'Appointment reminder robocall',
      voiceConfig: { msg: 'Randevunuz yarin.' },
      iysMessageType: 'TICARI',
    });
    expect(campaigns.create).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ channel: 'VOICE', iysMessageType: 'TICARI', voiceConfig: { msg: 'Randevunuz yarin.' } }),
    );
    // No launch/activate verb exists on this tool's deps at all.
    expect(Object.keys(campaigns)).toEqual(['create']);
  });

  it('is deferred and unattended — the arming step is what needs approval', () => {
    const { registry } = deps();
    const tool = registry.get('jeeta.create_voice_campaign')!;
    expect(tool.defer).toBe(true);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.risk).toBe('WRITE');
  });
});
