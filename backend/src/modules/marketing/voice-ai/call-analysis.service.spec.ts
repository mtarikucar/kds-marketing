import { CallAnalysisService } from './call-analysis.service';

function makeDeps() {
  const prisma = {
    salesCall: { findUnique: jest.fn() },
    callAnalysis: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
  };
  const stt = { transcribeUrl: jest.fn() };
  const anthropic = { complete: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const r2 = { urlForKey: jest.fn((key: string) => `https://cdn.example.com/${key}`) };
  const svc = new CallAnalysisService(prisma as any, stt as any, anthropic as any, credits as any, r2 as any);
  return { prisma, stt, anthropic, credits, r2, svc };
}

const CALL = { id: 'call-1', workspaceId: 'ws-1', recordingUrl: 'https://rec/x.mp3' };

describe('CallAnalysisService', () => {
  it('OK: STT → Claude JSON → upsert with parsed fields', async () => {
    const { prisma, stt, anthropic, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    stt.transcribeUrl.mockResolvedValue({ text: 'merhaba dünya', provider: 'deepgram', language: 'tr' });
    anthropic.complete.mockResolvedValue({
      text: JSON.stringify({ summary: 'kısa özet', sentiment: 'POSITIVE', score: 80, actionItems: ['ara'], topics: ['fiyat'] }),
    });

    const r = await svc.analyzeSalesCall('call-1');

    expect(r).toEqual({ status: 'OK' });
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 3);
    expect(credits.refund).not.toHaveBeenCalled();
    const arg = prisma.callAnalysis.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ salesCallId: 'call-1' });
    expect(arg.create).toMatchObject({
      workspaceId: 'ws-1',
      salesCallId: 'call-1',
      transcript: 'merhaba dünya',
      language: 'tr',
      summary: 'kısa özet',
      sentiment: 'POSITIVE',
      score: 80,
      actionItems: ['ara'],
      topics: ['fiyat'],
      sttProvider: 'deepgram',
    });
  });

  it('tolerant parse: strips ```json fences', async () => {
    const { prisma, stt, anthropic, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    stt.transcribeUrl.mockResolvedValue({ text: 't', provider: 'openai' });
    anthropic.complete.mockResolvedValue({
      text: '```json\n{"summary":"ok","sentiment":"NEUTRAL"}\n```',
    });

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('OK');
    expect(prisma.callAnalysis.upsert.mock.calls[0][0].create.summary).toBe('ok');
  });

  it('tolerant parse: non-JSON text falls back to {summary:text}', async () => {
    const { prisma, stt, anthropic, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    stt.transcribeUrl.mockResolvedValue({ text: 't', provider: 'openai' });
    anthropic.complete.mockResolvedValue({ text: 'just prose, no json here' });

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('OK');
    expect(prisma.callAnalysis.upsert.mock.calls[0][0].create.summary).toBe('just prose, no json here');
  });

  it('SKIPPED when an analysis already exists', async () => {
    const { prisma, stt, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    prisma.callAnalysis.findUnique.mockResolvedValue({ id: 'a1' });

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('SKIPPED');
    expect(stt.transcribeUrl).not.toHaveBeenCalled();
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('FAILED (no recording / no call)', async () => {
    const { prisma, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(null);
    const r = await svc.analyzeSalesCall('missing');
    expect(r.status).toBe('FAILED');
  });

  it('FAILED when the call has neither a storage key nor a provider recordingUrl', async () => {
    const { prisma, stt, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue({
      id: 'call-1',
      workspaceId: 'ws-1',
      recordingStorageKey: null,
      recordingUrl: null,
    });
    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('FAILED');
    expect(stt.transcribeUrl).not.toHaveBeenCalled();
  });

  // NetGSM Phase 4 Task 3 — STT prefers the stored file over the ephemeral
  // provider url when the recording has been ingested into R2.
  it('STT reads the R2-stored copy (not the provider recordingUrl) when recordingStorageKey is set', async () => {
    const { prisma, stt, anthropic, r2, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue({
      id: 'call-1',
      workspaceId: 'ws-1',
      recordingStorageKey: 'netgsm-recordings/ws-1/call-1.mp3',
      recordingUrl: 'https://netgsm.example.com/token/expiring-soon',
    });
    stt.transcribeUrl.mockResolvedValue({ text: 'merhaba', provider: 'deepgram' });
    anthropic.complete.mockResolvedValue({ text: JSON.stringify({ summary: 'ok' }) });

    const r = await svc.analyzeSalesCall('call-1');

    expect(r.status).toBe('OK');
    expect(r2.urlForKey).toHaveBeenCalledWith('netgsm-recordings/ws-1/call-1.mp3');
    expect(stt.transcribeUrl).toHaveBeenCalledWith('https://cdn.example.com/netgsm-recordings/ws-1/call-1.mp3');
  });

  it('STT falls back to the provider recordingUrl when no storage key exists yet', async () => {
    const { prisma, stt, anthropic, r2, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue({
      id: 'call-1',
      workspaceId: 'ws-1',
      recordingStorageKey: null,
      recordingUrl: 'https://netgsm.example.com/token/abc',
    });
    stt.transcribeUrl.mockResolvedValue({ text: 'merhaba', provider: 'deepgram' });
    anthropic.complete.mockResolvedValue({ text: JSON.stringify({ summary: 'ok' }) });

    const r = await svc.analyzeSalesCall('call-1');

    expect(r.status).toBe('OK');
    expect(r2.urlForKey).not.toHaveBeenCalled();
    expect(stt.transcribeUrl).toHaveBeenCalledWith('https://netgsm.example.com/token/abc');
  });

  it('FAILED when STT yields no text (no credit reserved)', async () => {
    const { prisma, stt, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    stt.transcribeUrl.mockResolvedValue(null);

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('FAILED');
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('refunds when Claude throws', async () => {
    const { prisma, stt, anthropic, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    stt.transcribeUrl.mockResolvedValue({ text: 't', provider: 'deepgram' });
    anthropic.complete.mockRejectedValue(new Error('boom'));

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('FAILED');
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 3);
    expect(credits.refund).toHaveBeenCalledWith('ws-1', 3);
    expect(prisma.callAnalysis.upsert).not.toHaveBeenCalled();
  });
});
