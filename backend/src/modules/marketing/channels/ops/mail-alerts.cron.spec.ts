import { MAIL_ALERT_NOTIFICATION, MailAlertsCron, RENOTIFY_MS } from './mail-alerts.cron';

/**
 * `no-email-observability` — the push half.
 *
 * The thresholds themselves are pure and tested in `mail-ops.service.spec.ts`;
 * what matters here is that the bell rings once per breach, reaches the people
 * who can act, stays quiet for a workspace the operator paused on purpose, and
 * that one broken tenant never stops the sweep for the rest.
 */

const NOW = new Date('2026-09-22T12:00:00.000Z');

/** A snapshot that breaches nothing. */
function healthy(workspaceId: string) {
  return {
    workspaceId,
    send: {
      attempted: 0,
      sent: 0,
      failedPermanent: 0,
      failedTransient: 0,
      bounced: 0,
      complained: 0,
      failureRate: 0,
      bounceRate: 0,
      complaintRate: 0,
    },
    inbound: { quarantined: 0 },
    mailboxes: [],
    paused: false,
  } as any;
}

/** A snapshot breaching exactly one thing: parked inbound mail. */
function quarantined(workspaceId: string, count = 3) {
  return { ...healthy(workspaceId), inbound: { quarantined: count } };
}

function build(over: { snapshot?: any; owners?: any[]; recent?: any } = {}) {
  const created: any[] = [];
  const prisma: any = {
    workspace: {
      findMany: jest.fn(async () => [{ id: 'ws-1', name: 'Acme' }]),
    },
    workspaceMembership: {
      findMany: jest.fn(async () => over.owners ?? [{ userId: 'u-owner' }]),
    },
    marketingNotification: {
      findFirst: jest.fn(async () => over.recent ?? null),
      create: jest.fn(async (args: any) => {
        created.push(args.data);
        return args.data;
      }),
    },
  };
  const ops = {
    snapshot: jest.fn(async (workspaceId: string) => over.snapshot?.(workspaceId) ?? healthy(workspaceId)),
  };
  return { prisma, ops, created, cron: new MailAlertsCron(prisma, ops as any) };
}

describe('MailAlertsCron.sweep', () => {
  it('says nothing about a workspace that is fine', async () => {
    const { cron, prisma } = build();
    await expect(cron.sweep(NOW)).resolves.toEqual({ workspaces: 1, alerts: 0, notified: 0 });
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
  });

  it('raises one notification per owner for a breach, carrying the numbers and a copy key', async () => {
    const { cron, prisma, created } = build({
      snapshot: (id: string) => quarantined(id, 7),
      owners: [{ userId: 'u-1' }, { userId: 'u-2' }],
    });

    const out = await cron.sweep(NOW);

    expect(out).toMatchObject({ alerts: 1, notified: 1 });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'u-1',
      type: MAIL_ALERT_NOTIFICATION,
    });
    expect(created[0].metadata).toMatchObject({
      alert: 'INBOUND_QUARANTINED',
      copyKey: 'mail.alert.INBOUND_QUARANTINED',
      count: 7,
    });
    expect(prisma.workspaceMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws-1', role: 'OWNER', status: 'ACTIVE' } }),
    );
  });

  // The failure mode that parks mail is almost never one mail: it is a mailbox
  // outage. Ringing once per row buries the very notice it is delivering.
  it('stays quiet when the same alert was already raised inside the re-notify window', async () => {
    const { cron, prisma } = build({
      snapshot: (id: string) => quarantined(id),
      recent: { id: 'notif-1' },
    });

    await expect(cron.sweep(NOW)).resolves.toMatchObject({ alerts: 1, notified: 0 });
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();

    const [args] = prisma.marketingNotification.findFirst.mock.calls[0];
    expect(args.where).toMatchObject({ workspaceId: 'ws-1', type: MAIL_ALERT_NOTIFICATION });
    expect(args.where.createdAt.gte.getTime()).toBe(NOW.getTime() - RENOTIFY_MS);
  });

  it('does not ring for a workspace whose sending the operator paused', async () => {
    const { cron, prisma } = build({
      snapshot: (id: string) => ({ ...quarantined(id), paused: true }),
    });
    await expect(cron.sweep(NOW)).resolves.toMatchObject({ alerts: 0, notified: 0 });
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
  });

  it('keeps sweeping when one workspace cannot be read', async () => {
    const { cron, prisma, created } = build({
      snapshot: (id: string) => {
        if (id === 'ws-1') throw new Error('P2024 pool timeout');
        return quarantined(id);
      },
    });
    prisma.workspace.findMany.mockResolvedValue([
      { id: 'ws-1', name: 'Broken' },
      { id: 'ws-2', name: 'Fine' },
    ]);

    await expect(cron.sweep(NOW)).resolves.toMatchObject({ workspaces: 2, notified: 1 });
    expect(created.map((c) => c.workspaceId)).toEqual(['ws-2']);
  });

  it('does not ring into the void when a workspace has no active owner', async () => {
    const { cron, prisma } = build({ snapshot: (id: string) => quarantined(id), owners: [] });
    await expect(cron.sweep(NOW)).resolves.toMatchObject({ alerts: 1, notified: 0 });
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
  });

  it('never throws out of the tick, whatever the database does', async () => {
    const { cron, prisma } = build({ snapshot: (id: string) => quarantined(id) });
    prisma.marketingNotification.findFirst.mockRejectedValue(new Error('down'));
    await expect(cron.sweep(NOW)).resolves.toMatchObject({ notified: 0 });
  });
});
