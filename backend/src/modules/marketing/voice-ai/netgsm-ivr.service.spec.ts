import { NetgsmIvrService } from './netgsm-ivr.service';

function makeDeps() {
  const prisma = {
    channel: { findMany: jest.fn().mockResolvedValue([]) },
    agentProfile: { findFirst: jest.fn() },
    // Default: no lead matches (unknown caller) — every pre-existing test in
    // this file predates lead personalization and asserts the unpersonalized
    // path, so this default keeps them green; personalization tests below
    // override it per-case.
    lead: { findFirst: jest.fn().mockResolvedValue(null) },
    voiceCall: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    voiceTranscript: { create: jest.fn().mockResolvedValue({}) },
  };
  const anthropic = { complete: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const knowledge = { search: jest.fn().mockResolvedValue([]) };
  const svc = new NetgsmIvrService(prisma as any, anthropic as any, credits as any, knowledge as any);
  return { prisma, anthropic, credits, knowledge, svc };
}

const CHANNEL = {
  id: 'chan-1',
  workspaceId: 'ws-1',
  type: 'VOICE',
  agentProfileId: 'agent-1',
  externalId: '08508407303',
  configPublic: { greeting: 'KDS Restorana hoş geldiniz.', handoffNumber: '5331234567' },
};
const AGENT = { persona: 'Yardımcı resepsiyonist', guardrails: 'Fiyat sözü verme', language: 'tr', kbDocIds: [] };

const INPUT = { arayan_no: '0533 123 45 67', santral_no: '0850 840 73 03', aranan_no: '0850 840 73 03', arama_id: 'call-xyz' };

describe('NetgsmIvrService', () => {
  it('first hit (no DTMF): greets + menu, records transcript, result "1"', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle(INPUT);

    expect(r.status).toBe('success');
    expect(r.result).toBe('1');
    expect(r.data).toContain('KDS Restorana hoş geldiniz.');
    expect(r.data.toLowerCase()).toMatch(/1|2/); // menu present
    // VoiceCall upserted keyed on arama_id with normalized numbers
    const up = prisma.voiceCall.upsert.mock.calls[0][0];
    expect(up.where).toEqual({ externalCallId: 'call-xyz' });
    expect(up.create).toMatchObject({
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      externalCallId: 'call-xyz',
      fromNumber: '05331234567',
      toNumber: '08508407303',
      status: 'IN_PROGRESS',
    });
    expect(prisma.voiceTranscript.create).toHaveBeenCalled();
  });

  it('unknown channel: safe default greeting, no throw, result "0"', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([]);

    const r = await svc.handle(INPUT);
    expect(r.status).toBe('success');
    expect(r.result).toBe('0');
    expect(typeof r.data).toBe('string');
    expect(r.data.length).toBeGreaterThan(0);
    expect(prisma.voiceCall.upsert).not.toHaveBeenCalled();
  });

  it('resolves ONLY ACTIVE voice channels (a DISABLED channel must go silent, not answer + meter)', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    await svc.handle(INPUT);

    const where = prisma.channel.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.type).toBe('VOICE');
  });

  it('FAILS CLOSED when the suffix match is ambiguous across workspaces (no cross-tenant hijack)', async () => {
    const { prisma, svc } = makeDeps();
    // Two tenants stored the same subscriber number in different formats —
    // both suffix-match. Answering with an arbitrary pick would read the
    // WRONG tenant's KB aloud, bill its wallet and write the caller's PII
    // into its VoiceCall rows. The caller must get the neutral fallback.
    prisma.channel.findMany.mockResolvedValue([
      { ...CHANNEL, id: 'ch-A', workspaceId: 'ws-A' },
      { ...CHANNEL, id: 'ch-B', workspaceId: 'ws-B' },
    ]);

    const r = await svc.handle(INPUT);
    expect(r.result).toBe('0'); // neutral unknown-line greeting
    expect(prisma.voiceCall.upsert).not.toHaveBeenCalled(); // no wrong-tenant writes
  });

  it('multiple matches in the SAME workspace resolve deterministically (first row), no fail-closed', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([
      { ...CHANNEL, id: 'ch-1' },
      { ...CHANNEL, id: 'ch-2' },
    ]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle(INPUT);
    expect(r.result).toBe('1'); // answered normally
    expect(prisma.voiceCall.upsert).toHaveBeenCalled();
  });

  it('agent digit "2": dynamic redirect to handoffNumber', async () => {
    const { prisma, anthropic, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });

    expect(r.result).toBe('dynamic');
    expect(r.data).toBe('Aktarıyorum');
    expect((r as any).redirect).toBe('5331234567');
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it('info digit "1": Claude generates info text, reserves credit, result "1"', async () => {
    const { prisma, anthropic, credits, knowledge, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    anthropic.complete.mockResolvedValue({ text: 'Çalışma saatlerimiz 09:00 - 22:00 arasıdır.' });

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '1' });

    expect(r.result).toBe('1');
    expect(r.data).toContain('Çalışma saatlerimiz');
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 2);
    expect(credits.refund).not.toHaveBeenCalled();
    expect(knowledge.search).toHaveBeenCalled();
    // system prompt should carry persona
    const arg = anthropic.complete.mock.calls[0][0];
    expect(arg.system).toContain('Yardımcı resepsiyonist');
    expect(arg.maxTokens).toBe(120);
    expect(arg.tier).toBe('conversation');
  });

  it('info digit refunds credit when Claude throws', async () => {
    const { prisma, anthropic, credits, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    anthropic.complete.mockRejectedValue(new Error('boom'));

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '1' });

    expect(r.status).toBe('success');
    expect(r.result).toBe('1');
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 2);
    expect(credits.refund).toHaveBeenCalledWith('ws-1', 2);
  });

  it('resolves channel by santral_no when aranan_no does not match (last-10-digit)', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    await svc.handle({ ...INPUT, aranan_no: '' });
    // findFirst called with an externalId set containing the normalized santral number
    const where = prisma.channel.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('8508407303');
  });

  // ── Task 6: dynamic IVR personalization ─────────────────────────────────

  const LEAD_NO_REP = { id: 'lead-1', contactPerson: 'Ahmet Yılmaz', assignedTo: null };
  const LEAD_WITH_REP = {
    id: 'lead-2',
    contactPerson: 'Elif Demir',
    assignedTo: { dahili: '104', phone: '5559998877' },
  };

  const CHANNEL_PERSONALIZE = { ...CHANNEL, configPublic: { ...CHANNEL.configPublic, ivrPersonalize: true } };

  it('known caller (no DTMF) WITH ivrPersonalize opt-in: greets by name, stamps leadId on the VoiceCall row', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL_PERSONALIZE]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    prisma.lead.findFirst.mockResolvedValue(LEAD_NO_REP);

    const r = await svc.handle(INPUT);

    expect(r.result).toBe('1');
    expect(r.data).toContain('Merhaba Ahmet Yılmaz Bey/Hanım');
    // known-caller greeting replaces the tenant's configured greeting text
    expect(r.data).not.toContain('KDS Restorana hoş geldiniz.');
    const up = prisma.voiceCall.upsert.mock.calls[0][0];
    expect(up.create.leadId).toBe('lead-1');
    // canonical phone match: searched against every localMsisdnVariants spelling
    const leadWhere = prisma.lead.findFirst.mock.calls[0][0].where;
    expect(leadWhere.workspaceId).toBe('ws-1');
    expect(leadWhere.phoneNormalized.in).toEqual(expect.arrayContaining(['5331234567', '05331234567', '905331234567']));
  });

  it('known caller WITHOUT ivrPersonalize (default off): does NOT speak the name (Caller-ID is spoofable), still stamps leadId', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]); // no ivrPersonalize flag
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    prisma.lead.findFirst.mockResolvedValue(LEAD_NO_REP);

    const r = await svc.handle(INPUT);

    expect(r.data).not.toContain('Ahmet Yılmaz'); // name never spoken by default
    expect(r.data).toContain('KDS Restorana hoş geldiniz.'); // tenant's generic greeting
    // leadId is still stamped for the rep-facing log + routing (not caller-audible PII)
    expect(prisma.voiceCall.upsert.mock.calls[0][0].create.leadId).toBe('lead-1');
  });

  it('unknown caller (no lead match): greeting + VoiceCall unaffected, leadId null', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    // default mock already resolves null; assert explicitly for clarity here.
    prisma.lead.findFirst.mockResolvedValue(null);

    const r = await svc.handle(INPUT);

    expect(r.data).toContain('KDS Restorana hoş geldiniz.');
    expect(r.data).not.toContain('Bey/Hanım');
    const up = prisma.voiceCall.upsert.mock.calls[0][0];
    expect(up.create.leadId).toBeNull();
  });

  it('agent digit "2", known caller with an assigned rep: dynamic redirect to the rep dahili (not the tenant handoffNumber)', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    prisma.lead.findFirst.mockResolvedValue(LEAD_WITH_REP);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });

    expect(r.result).toBe('dynamic');
    expect((r as any).redirect).toBe('104'); // rep's dahili, not '5331234567'
  });

  it('agent digit "2", known caller with an assigned rep but no dahili: falls back to the rep phone', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-3', contactPerson: 'Zeynep Kaya', assignedTo: { dahili: null, phone: '5551112233' },
    });

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });
    expect((r as any).redirect).toBe('5551112233');
  });

  it('agent digit "2", known caller with no assigned rep: falls back to configured priorityQueue', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([{
      ...CHANNEL, configPublic: { ...CHANNEL.configPublic, priorityQueue: '850-queue-vip' },
    }]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    prisma.lead.findFirst.mockResolvedValue(LEAD_NO_REP); // assignedTo: null

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });
    expect((r as any).redirect).toBe('850-queue-vip');
  });

  it('agent digit "2", known caller with no rep/queue configured: falls back to the tenant handoffNumber (prior behavior)', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([CHANNEL]); // no priorityQueue configured
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);
    prisma.lead.findFirst.mockResolvedValue(LEAD_NO_REP);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });
    expect((r as any).redirect).toBe('5331234567');
  });

  it('configPublic.ivrMenu honored: a configured digit answers straight from config, bypassing Claude/agent-handoff', async () => {
    const { prisma, anthropic, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([{
      ...CHANNEL,
      configPublic: {
        ...CHANNEL.configPublic,
        ivrMenu: { '3': { data: 'Şubemiz hafta içi 09:00-18:00 açıktır.', redirect: '850-queue-sales' } },
      },
    }]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '3' });

    expect(r.result).toBe('dynamic');
    expect(r.data).toBe('Şubemiz hafta içi 09:00-18:00 açıktır.');
    expect((r as any).redirect).toBe('850-queue-sales');
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it('configPublic.ivrMenu entry without a redirect: result "1", no redirect field', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([{
      ...CHANNEL,
      configPublic: { ...CHANNEL.configPublic, ivrMenu: { '3': { data: 'Bilgilendirme mesajı.' } } },
    }]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '3' });
    expect(r.result).toBe('1');
    expect(r.data).toBe('Bilgilendirme mesajı.');
    expect((r as any).redirect).toBeUndefined();
  });

  it('configPublic.ivrMenu still honors an AGENT_DIGITS entry (e.g. "2") when explicitly configured', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([{
      ...CHANNEL,
      configPublic: { ...CHANNEL.configPublic, ivrMenu: { '2': { data: 'Özel karşılama.', redirect: '850-queue-custom' } } },
    }]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });
    expect(r.data).toBe('Özel karşılama.');
    expect((r as any).redirect).toBe('850-queue-custom');
  });

  it('malformed configPublic.ivrMenu entries are dropped, not thrown — falls through to the hardcoded menu', async () => {
    const { prisma, svc } = makeDeps();
    prisma.channel.findMany.mockResolvedValue([{
      ...CHANNEL,
      configPublic: { ...CHANNEL.configPublic, ivrMenu: { '2': { data: 123 }, '9': 'not-an-object' } },
    }]);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });
    // digit "2" had no usable `data` string — falls through to the hardcoded
    // agent-handoff branch exactly as if ivrMenu were absent.
    expect(r.result).toBe('dynamic');
    expect(r.data).toBe('Aktarıyorum');
  });
});
