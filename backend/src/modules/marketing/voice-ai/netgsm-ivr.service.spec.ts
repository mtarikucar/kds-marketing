import { NetgsmIvrService } from './netgsm-ivr.service';

function makeDeps() {
  const prisma = {
    channel: { findFirst: jest.fn() },
    agentProfile: { findFirst: jest.fn() },
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
    prisma.channel.findFirst.mockResolvedValue(CHANNEL);
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
    prisma.channel.findFirst.mockResolvedValue(null);

    const r = await svc.handle(INPUT);
    expect(r.status).toBe('success');
    expect(r.result).toBe('0');
    expect(typeof r.data).toBe('string');
    expect(r.data.length).toBeGreaterThan(0);
    expect(prisma.voiceCall.upsert).not.toHaveBeenCalled();
  });

  it('agent digit "2": dynamic redirect to handoffNumber', async () => {
    const { prisma, anthropic, svc } = makeDeps();
    prisma.channel.findFirst.mockResolvedValue(CHANNEL);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    const r = await svc.handle({ ...INPUT, tus_bilgisi: '2' });

    expect(r.result).toBe('dynamic');
    expect(r.data).toBe('Aktarıyorum');
    expect((r as any).redirect).toBe('5331234567');
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it('info digit "1": Claude generates info text, reserves credit, result "1"', async () => {
    const { prisma, anthropic, credits, knowledge, svc } = makeDeps();
    prisma.channel.findFirst.mockResolvedValue(CHANNEL);
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
    prisma.channel.findFirst.mockResolvedValue(CHANNEL);
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
    prisma.channel.findFirst.mockResolvedValue(CHANNEL);
    prisma.agentProfile.findFirst.mockResolvedValue(AGENT);

    await svc.handle({ ...INPUT, aranan_no: '' });
    // findFirst called with an externalId set containing the normalized santral number
    const where = prisma.channel.findFirst.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('8508407303');
  });
});
