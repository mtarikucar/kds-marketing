import { CallAnalysisService } from './call-analysis.service';
import { creditCost } from '../ai/ai-credit-costs';
import { McpAiTaskService } from '../ai/mcp-ai-task.service';

function makeDeps() {
  const prisma = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ aiSpendPolicy: null }) },
    salesCall: { findUnique: jest.fn() },
    callAnalysis: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
  };
  const stt = { transcribeUrl: jest.fn() };
  const anthropic = { complete: jest.fn(), isEnabledFor: jest.fn().mockReturnValue(true) };
  const credits = { reserveForJob: jest.fn(async (_ws: string, action: any, override?: number) => override ?? creditCost(action === 'brand.safety' ? 'workflow.ai_classify' : action)), refund: jest.fn().mockResolvedValue(undefined) };
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
    expect(credits.reserveForJob).toHaveBeenCalledWith('ws-1', 'voice.analysis');
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
    expect(credits.reserveForJob).not.toHaveBeenCalled();
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
    expect(stt.transcribeUrl).toHaveBeenCalledWith('https://cdn.example.com/netgsm-recordings/ws-1/call-1.mp3', { workspaceId: 'ws-1' });
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
    expect(stt.transcribeUrl).toHaveBeenCalledWith('https://netgsm.example.com/token/abc', { workspaceId: 'ws-1' });
  });

  /**
   * Transcription is Jeeta's cost (Deepgram/Whisper on a platform key) and it
   * used to run BEFORE any reserve — so a workspace at zero credits still
   * burned it, and an empty transcript returned early and was billed to nobody.
   * It is charged up front per minute now and refunded when nothing usable
   * comes back; the ANALYSIS credit is still never reserved, because no LLM
   * call happens.
   */
  it('refunds the STT charge — and never reserves the analysis — when STT yields no text', async () => {
    const { prisma, stt, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue({ ...CALL, durationSec: 90 });
    stt.transcribeUrl.mockResolvedValue(null);

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('FAILED');

    // 90s → 2 minutes, charged up front then handed back.
    const sttCost = creditCost('stt.minute') * 2;
    expect(credits.reserveForJob).toHaveBeenCalledTimes(1);
    expect(credits.reserveForJob).toHaveBeenCalledWith('ws-1', 'stt.minute', sttCost);
    expect(credits.refund).toHaveBeenCalledWith('ws-1', sttCost);
    expect(credits.reserveForJob).not.toHaveBeenCalledWith('ws-1', 'voice.analysis');
  });

  it('charges STT before transcribing, so an out-of-credits workspace cannot burn it', async () => {
    const { prisma, stt, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue({ ...CALL, durationSec: 30 });
    credits.reserveForJob.mockRejectedValueOnce(new Error('AI_CREDITS_EXHAUSTED'));

    await expect(svc.analyzeSalesCall('call-1')).rejects.toThrow('AI_CREDITS_EXHAUSTED');
    // The whole point: the vendor call never happened.
    expect(stt.transcribeUrl).not.toHaveBeenCalled();
  });

  it('refunds when Claude throws', async () => {
    const { prisma, stt, anthropic, credits, svc } = makeDeps();
    prisma.salesCall.findUnique.mockResolvedValue(CALL);
    stt.transcribeUrl.mockResolvedValue({ text: 't', provider: 'deepgram' });
    anthropic.complete.mockRejectedValue(new Error('boom'));

    const r = await svc.analyzeSalesCall('call-1');
    expect(r.status).toBe('FAILED');
    expect(credits.reserveForJob).toHaveBeenCalledWith('ws-1', 'voice.analysis');
    expect(credits.refund).toHaveBeenCalledWith('ws-1', 3);
    expect(prisma.callAnalysis.upsert).not.toHaveBeenCalled();
  });
});

describe('CallAnalysisService MCP transcript retries', () => {
  const wait = process.env.AI_MCP_WAIT_MS;
  beforeEach(() => { process.env.AI_MCP_WAIT_MS = '0'; });
  afterEach(() => {
    if (wait === undefined) delete process.env.AI_MCP_WAIT_MS;
    else process.env.AI_MCP_WAIT_MS = wait;
  });

  function setup() {
    const h = makeDeps();
    const rows: any[] = [];
    const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === 'AND') return value.every((clause: any) => matches(row, clause));
      if (value?.path) return value.path.reduce((v: any, field: string) => v?.[field], row[key]) === value.equals;
      if (value?.in) return value.in.includes(row[key]);
      if (value?.gt) return row[key] > value.gt;
      return row[key] === value;
    });
    const prisma = Object.assign(h.prisma, {
      scheduledJob: {
        findFirst: jest.fn(async ({ where }: any) => structuredClone(rows.findLast((row) => matches(row, where)) ?? null)),
        count: jest.fn(async ({ where }: any) => rows.filter((row) => matches(row, where)).length),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `task-${rows.length + 1}`, createdAt: new Date(), ...structuredClone(data) };
          rows.push(row);
          return structuredClone(row);
        }),
      },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    });
    prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'voice.analysis': { provider: 'MCP' } } } } as any);
    prisma.salesCall.findUnique.mockResolvedValue({ ...CALL, durationSec: 90 });
    h.stt.transcribeUrl.mockResolvedValue({ text: 'merhaba dünya', provider: 'deepgram', language: 'tr' });
    h.credits.reserveForJob.mockImplementation(async (_ws, action, override) => action === 'voice.analysis' ? 0 : override ?? 1);
    const tasks = new McpAiTaskService(prisma as any);
    h.anthropic.complete.mockImplementation((opts: any) => tasks.generate(opts));
    const retry = () => new CallAnalysisService(prisma as any, h.stt as any, h.anthropic as any, h.credits as any, h.r2 as any).analyzeSalesCall(CALL.id);
    const finish = () => {
      const row = rows.at(-1)!;
      row.status = 'MCP_DONE';
      row.payload.result = { text: '{"summary":"cached transcript analyzed"}', toolUses: [], stopReason: 'end_turn', usage: { input: 0, output: 0 } };
    };
    return { ...h, prisma, rows, retry, finish };
  }

  it('reuses the persisted transcript and provenance after MCP waiting without another STT charge', async () => {
    const h = setup();
    expect(await h.svc.analyzeSalesCall(CALL.id)).toEqual({ status: 'SKIPPED', reason: 'AI_MCP_WAITING: Bağlı Claude yanıtı bekleniyor.' });
    expect(await h.retry()).toEqual({ status: 'SKIPPED', reason: 'AI_MCP_WAITING: Bağlı Claude yanıtı bekleniyor.' });
    h.finish();
    expect(await h.retry()).toEqual({ status: 'OK' });
    expect(h.stt.transcribeUrl).toHaveBeenCalledTimes(1);
    expect(h.credits.reserveForJob.mock.calls.filter(([, action]) => action === 'stt.minute')).toEqual([['ws-1', 'stt.minute', 2]]);
    expect(h.rows).toHaveLength(1);
    expect(h.prisma.callAnalysis.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ transcript: 'merhaba dünya', sttProvider: 'deepgram', language: 'tr' }) }));
    expect(h.anthropic.complete.mock.calls[0][0].idempotencyScope).toEqual(expect.any(String));
    expect(h.anthropic.complete.mock.calls[0][0].idempotencyScope).not.toContain(CALL.recordingUrl);
  });

  it.each([
    { recordingUrl: 'https://rec/replaced.mp3' },
    { recordingStorageKey: 'recordings/ws-1/new.mp3' },
    { id: 'call-2' },
    { workspaceId: 'ws-2' },
  ])('does not reuse a transcript after its call/source/workspace changes: %j', async (change) => {
    const h = setup();
    await h.svc.analyzeSalesCall(CALL.id);
    h.prisma.salesCall.findUnique.mockResolvedValue({ ...CALL, ...change });
    // Identical transcript text must not make two calls/sources share a task.
    await h.svc.analyzeSalesCall(change.id ?? CALL.id);
    expect(h.stt.transcribeUrl).toHaveBeenCalledTimes(2);
    expect(h.rows).toHaveLength(2);
  });

  it('analyzes an existing transcript after STT is switched off without requesting new transcription', async () => {
    const h = setup();
    await h.svc.analyzeSalesCall(CALL.id);
    h.finish();
    h.prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'voice.analysis': { provider: 'MCP' }, 'stt.minute': { enabled: false } } } } as any);
    h.credits.reserveForJob.mockImplementation(async (_ws, action) => {
      if (action === 'stt.minute') throw new Error('STT disabled');
      return 0;
    });
    expect(await h.retry()).toEqual({ status: 'OK' });
    expect(h.stt.transcribeUrl).toHaveBeenCalledTimes(1);
  });

  it('retains the paid transcript when an inference task expires', async () => {
    const h = setup();
    await h.svc.analyzeSalesCall(CALL.id);
    h.rows[0].status = 'CANCELLED';
    h.rows[0].createdAt = new Date(Date.now() - 31 * 60_000);
    await h.retry();
    expect(h.rows).toHaveLength(2);
    h.finish();
    expect(await h.retry()).toEqual({ status: 'OK' });
    expect(h.stt.transcribeUrl).toHaveBeenCalledTimes(1);
    expect(h.credits.reserveForJob.mock.calls.filter(([, action]) => action === 'stt.minute')).toHaveLength(1);
  });

  it('does not refund the original STT charge when a later analysis reservation fails', async () => {
    const h = setup();
    await h.svc.analyzeSalesCall(CALL.id);
    h.credits.refund.mockClear();
    h.credits.reserveForJob.mockRejectedValueOnce(new Error('analysis disabled during retry'));
    await expect(h.retry()).rejects.toThrow('analysis disabled during retry');
    expect(h.stt.transcribeUrl).toHaveBeenCalledTimes(1);
    expect(h.credits.refund).toHaveBeenCalledWith('ws-1', 0);
  });
});
