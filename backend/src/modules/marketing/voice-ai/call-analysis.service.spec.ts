import { CallAnalysisService } from './call-analysis.service';

function makeDeps() {
  const prisma = {
    salesCall: { findUnique: jest.fn() },
    callAnalysis: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
  };
  const stt = { transcribeUrl: jest.fn() };
  const anthropic = { complete: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const svc = new CallAnalysisService(prisma as any, stt as any, anthropic as any, credits as any);
  return { prisma, stt, anthropic, credits, svc };
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
