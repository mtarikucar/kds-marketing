import { HostResolverService } from './host-resolver.service';

/**
 * Builds a resolver over an in-memory set of connection rows. `findFirst`
 * honours the `marketingUserId` + `enabled` filter (and returns the first
 * enabled row when no user is given, mirroring the workspace fallback).
 */
function resolver(rows: any[], ownerUserId: string | null = 'owner1') {
  const findFirst = jest.fn(async ({ where }: any) => {
    if (where.marketingUserId) {
      return (
        rows.find(
          (r) => r.marketingUserId === where.marketingUserId && r.enabled,
        ) ?? null
      );
    }
    return rows.find((r) => r.enabled) ?? null;
  });
  const prisma: any = {
    googleCalendarConnection: { findFirst },
    outlookCalendarConnection: { findFirst },
    bookingCalendar: { findFirst: jest.fn(async () => ({ ownerUserId })) },
  };
  return { svc: new HostResolverService(prisma), prisma };
}

describe('HostResolverService', () => {
  it('prefers the assignee connection', async () => {
    const { svc } = resolver([
      { id: 'gA', marketingUserId: 'assignee1', enabled: true },
      { id: 'gOwner', marketingUserId: 'owner1', enabled: true },
    ]);
    const host = await svc.resolve(
      'ws1',
      { calendarId: 'c1', assigneeUserId: 'assignee1' },
      'GOOGLE_MEET',
    );
    expect(host).toEqual({
      kind: 'GOOGLE_MEET',
      connectionId: 'gA',
      marketingUserId: 'assignee1',
    });
  });

  it('falls back to the calendar owner when the assignee is not connected', async () => {
    const { svc } = resolver([
      { id: 'gOwner', marketingUserId: 'owner1', enabled: true },
    ]);
    const host = await svc.resolve(
      'ws1',
      { calendarId: 'c1', assigneeUserId: 'nobody' },
      'GOOGLE_MEET',
    );
    expect(host?.connectionId).toBe('gOwner');
  });

  it('falls back to the first enabled workspace connection', async () => {
    const { svc } = resolver(
      [{ id: 'gWs', marketingUserId: 'someoneElse', enabled: true }],
      null, // no calendar owner
    );
    const host = await svc.resolve(
      'ws1',
      { calendarId: 'c1', assigneeUserId: null },
      'GOOGLE_MEET',
    );
    expect(host?.connectionId).toBe('gWs');
  });

  it('resolves Teams against the Outlook connection table', async () => {
    const { svc, prisma } = resolver([
      { id: 'oA', marketingUserId: 'assignee1', enabled: true },
    ]);
    const host = await svc.resolve(
      'ws1',
      { calendarId: 'c1', assigneeUserId: 'assignee1' },
      'TEAMS',
    );
    expect(host?.kind).toBe('TEAMS');
    expect(prisma.outlookCalendarConnection.findFirst).toHaveBeenCalled();
  });

  it('returns null when no connection exists', async () => {
    const { svc } = resolver([], null);
    const host = await svc.resolve(
      'ws1',
      { calendarId: 'c1', assigneeUserId: 'x' },
      'GOOGLE_MEET',
    );
    expect(host).toBeNull();
  });
});
