import { CallAnalysisCron } from './call-analysis.cron';

jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => { await cb(); }),
}));

const OLD = process.env;

function makeCron() {
  const prisma = {
    salesCall: { findMany: jest.fn().mockResolvedValue([]) },
    callAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const anthropic = { isEnabled: jest.fn().mockReturnValue(true) };
  const analysis = { analyzeSalesCall: jest.fn().mockResolvedValue({ status: 'OK' }) };
  const cron = new CallAnalysisCron(prisma as any, anthropic as any, analysis as any);
  return { prisma, anthropic, analysis, cron };
}

describe('CallAnalysisCron', () => {
  beforeEach(() => {
    process.env = { ...OLD, STT_PROVIDER: 'deepgram', STT_API_KEY: 'k' };
  });
  afterAll(() => { process.env = OLD; });
  afterEach(() => jest.clearAllMocks());

  it('is INERT when STT is not configured (no DB read)', async () => {
    delete process.env.STT_PROVIDER;
    const { prisma, analysis, cron } = makeCron();
    await cron.sweep();
    expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
    expect(analysis.analyzeSalesCall).not.toHaveBeenCalled();
  });

  it('is INERT when Claude is disabled', async () => {
    const { prisma, anthropic, cron } = makeCron();
    anthropic.isEnabled.mockReturnValue(false);
    await cron.sweep();
    expect(prisma.salesCall.findMany).not.toHaveBeenCalled();
  });

  it('queries due calls and analyzes each (capped at 25)', async () => {
    const { prisma, analysis, cron } = makeCron();
    prisma.salesCall.findMany.mockResolvedValue([
      { id: 'c1' },
      { id: 'c2' },
    ]);
    await cron.sweep();
    const arg = prisma.salesCall.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ status: 'CONNECTED', recordingUrl: { not: null } });
    expect(arg.where.endedAt.gte).toBeInstanceOf(Date);
    expect(arg.take).toBe(25);
    expect(analysis.analyzeSalesCall).toHaveBeenCalledTimes(2);
    expect(analysis.analyzeSalesCall).toHaveBeenCalledWith('c1');
    expect(analysis.analyzeSalesCall).toHaveBeenCalledWith('c2');
  });

  it('excludes calls that already have a CallAnalysis', async () => {
    const { prisma, analysis, cron } = makeCron();
    prisma.salesCall.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    prisma.callAnalysis.findMany.mockResolvedValue([{ salesCallId: 'c1' }]);
    await cron.sweep();
    // c1 already analyzed → only c2 is processed.
    expect(analysis.analyzeSalesCall).toHaveBeenCalledTimes(1);
    expect(analysis.analyzeSalesCall).toHaveBeenCalledWith('c2');
  });

  it('swallows a per-row error and continues to the next row', async () => {
    const { prisma, analysis, cron } = makeCron();
    prisma.salesCall.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    analysis.analyzeSalesCall.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ status: 'OK' });
    await expect(cron.sweep()).resolves.toBeUndefined();
    expect(analysis.analyzeSalesCall).toHaveBeenCalledTimes(2);
  });
});
