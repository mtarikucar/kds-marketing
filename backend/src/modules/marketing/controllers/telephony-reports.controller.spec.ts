import { TelephonyReportsController } from './telephony-reports.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'mgr-1', workspaceId: 'ws-1', role: 'MANAGER' } as MarketingUserPayload;

function makeController() {
  const reports = { statistics: jest.fn() };
  const ctrl = new TelephonyReportsController(reports as any);
  return { reports, ctrl };
}

describe('TelephonyReportsController', () => {
  it('GET statistics delegates to the service with the workspace + query bounds', async () => {
    const { reports, ctrl } = makeController();
    reports.statistics.mockResolvedValue({ ok: true, daily: [], summary: { answered: 0, abandoned: 0, avgWaitSec: null } });

    const res = await ctrl.statistics(USER, { from: '2026-07-01', to: '2026-07-07' });

    expect(reports.statistics).toHaveBeenCalledWith('ws-1', '2026-07-01', '2026-07-07');
    expect(res).toEqual({ ok: true, daily: [], summary: { answered: 0, abandoned: 0, avgWaitSec: null } });
  });

  it('forwards undefined from/to when the query is empty (service applies its own default window)', async () => {
    const { reports, ctrl } = makeController();
    reports.statistics.mockResolvedValue({ ok: true });

    await ctrl.statistics(USER, {});

    expect(reports.statistics).toHaveBeenCalledWith('ws-1', undefined, undefined);
  });
});
