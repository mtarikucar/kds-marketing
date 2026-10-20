import { Ga4SyncCron } from './ga4-sync.cron';

jest.mock('../../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: unknown, _name: string, run: () => Promise<void>) => run()),
}));
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';

const NOW = new Date('2026-10-21T08:15:00.000Z');
const KEY = Buffer.alloc(32, 9).toString('base64');

function build(due: Array<{ id: string }> = [{ id: 'c1' }, { id: 'c2' }]) {
  const prisma = { ga4Connection: { findMany: jest.fn().mockResolvedValue(due) } };
  const sync = { syncConnection: jest.fn().mockResolvedValue({ status: 'synced', rows: 3 }) };
  return { prisma, sync, cron: new Ga4SyncCron(prisma as never, sync as never) };
}

describe('Ga4SyncCron (contract §6.3, B4)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.GA4_SYNC_ENABLED = 'true';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    process.env.MARKETING_SECRET_KEY = KEY;
    (withAdvisoryLock as jest.Mock).mockClear();
  });
  afterAll(() => {
    process.env = saved;
  });

  it('runs under the ga4:daily-sync advisory lock', async () => {
    const { cron } = build();
    await cron.runDue(NOW);
    expect((withAdvisoryLock as jest.Mock).mock.calls[0][1]).toBe('ga4:daily-sync');
  });

  it('picks enabled connections with a property, not synced in 20 h, oldest first, 20 at a time', async () => {
    const { cron, prisma, sync } = build();
    const out = await cron.runDue(NOW);
    expect(prisma.ga4Connection.findMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        propertyId: { not: null },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date('2026-10-20T12:15:00.000Z') } }],
      },
      orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
      take: 20,
    });
    expect(sync.syncConnection).toHaveBeenCalledTimes(2);
    expect(sync.syncConnection).toHaveBeenCalledWith({ id: 'c1' }, NOW);
    expect(out).toEqual({ ran: true, connections: 2, synced: 2, failed: 0 });
  });

  it('one failing workspace does not stop the others', async () => {
    const { cron, sync } = build();
    sync.syncConnection.mockRejectedValueOnce(new Error('boom'));
    const out = await cron.runDue(NOW);
    expect(sync.syncConnection).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ synced: 1, failed: 1 });
  });

  it('counts a reported failure (e.g. REAUTH_REQUIRED) as failed', async () => {
    const { cron, sync } = build([{ id: 'c1' }]);
    sync.syncConnection.mockResolvedValueOnce({ status: 'failed', rows: 0, error: 'REAUTH_REQUIRED' });
    expect(await cron.runDue(NOW)).toMatchObject({ synced: 0, failed: 1 });
  });

  const offCases: Array<[string, () => void]> = [
    ['GA4_SYNC_ENABLED is off', () => (process.env.GA4_SYNC_ENABLED = 'false')],
    [
      'the Google OAuth client is not configured',
      () => {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_ID;
      },
    ],
    ['MARKETING_SECRET_KEY is missing', () => delete process.env.MARKETING_SECRET_KEY],
  ];
  it.each(offCases)('skips entirely when %s', async (_label, arrange) => {
    arrange();
    let Fresh!: typeof Ga4SyncCron;
    // The secret box caches the key once read; load fresh copies for the missing-key case.
    jest.isolateModules(() => {
      Fresh = require('./ga4-sync.cron').Ga4SyncCron;
    });
    const prisma = { ga4Connection: { findMany: jest.fn() } };
    const out = await new Fresh(prisma as never, { syncConnection: jest.fn() } as never).runDue(NOW);
    expect(out).toEqual({ ran: false, connections: 0, synced: 0, failed: 0 });
    expect(prisma.ga4Connection.findMany).not.toHaveBeenCalled();
  });
});
