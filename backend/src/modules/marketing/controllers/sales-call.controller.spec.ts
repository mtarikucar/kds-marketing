import { SalesCallController } from './sales-call.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'u1', workspaceId: 'ws-1', role: 'MANAGER' } as MarketingUserPayload;

function makeController() {
  const calls = { get: jest.fn() };
  const prisma = { callAnalysis: { findUnique: jest.fn() } };
  const analysis = { analyzeSalesCall: jest.fn() };
  const ctrl = new SalesCallController(calls as any, prisma as any, analysis as any);
  return { calls, prisma, analysis, ctrl };
}

describe('SalesCallController — analysis endpoints', () => {
  it('GET :id/analysis returns the workspace-scoped analysis', async () => {
    const { calls, prisma, ctrl } = makeController();
    calls.get.mockResolvedValue({ id: 'call-1', workspaceId: 'ws-1' });
    prisma.callAnalysis.findUnique.mockResolvedValue({ id: 'a1', salesCallId: 'call-1', summary: 'ok' });

    const r = await ctrl.analysis('call-1', USER);
    // the call ownership is verified through the rep-scoped get (REP sees only own).
    expect(calls.get).toHaveBeenCalledWith('ws-1', 'call-1', USER);
    expect(r).toMatchObject({ id: 'a1', summary: 'ok' });
  });

  it('GET :id/analysis returns {status:NONE} when no analysis exists', async () => {
    const { calls, prisma, ctrl } = makeController();
    calls.get.mockResolvedValue({ id: 'call-1', workspaceId: 'ws-1' });
    prisma.callAnalysis.findUnique.mockResolvedValue(null);

    const r = await ctrl.analysis('call-1', USER);
    expect(r).toEqual({ status: 'NONE' });
  });

  it('POST :id/analysis/run triggers analyzeSalesCall after ownership check', async () => {
    const { calls, analysis, ctrl } = makeController();
    calls.get.mockResolvedValue({ id: 'call-1', workspaceId: 'ws-1' });
    analysis.analyzeSalesCall.mockResolvedValue({ status: 'OK' });

    const r = await ctrl.runAnalysis('call-1', USER);
    expect(calls.get).toHaveBeenCalledWith('ws-1', 'call-1', USER);
    expect(analysis.analyzeSalesCall).toHaveBeenCalledWith('call-1');
    expect(r).toEqual({ status: 'OK' });
  });
});
