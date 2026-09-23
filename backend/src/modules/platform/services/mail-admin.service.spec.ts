import { MailAdminService } from './mail-admin.service';

/**
 * `no-email-observability` — the operator half.
 *
 * "Whose blast tripped the relay, whose mailbox is dead, and who did I pause?"
 * — answered with four grouped reads over the ledgers, not one snapshot per
 * tenant. The pause switch is the only write, and it must leave the rest of a
 * workspace's free-shape settings exactly as it found them.
 */

const NOW = new Date('2026-09-22T12:00:00.000Z');
const DAY_START = new Date('2026-09-22T00:00:00.000Z');

function counted(rows: Record<string, unknown>[]): any[] {
  return rows.map((r) => ({ ...r, _count: { _all: (r as any)._n ?? 1 } }));
}

function build(over: any = {}) {
  const prisma: any = {
    workspace: {
      findMany: jest.fn(async () => [
        { id: 'ws-1', name: 'Acme', status: 'ACTIVE', settings: { brand: 'keep me' } },
        { id: 'ws-2', name: 'Beta', status: 'ACTIVE', settings: { email: { paused: true } } },
      ]),
      findFirst: jest.fn(async () => ({ settings: { brand: 'keep me' } })),
      update: jest.fn(async (args: any) => args.data),
    },
    mailLog: { groupBy: jest.fn(async () => []) },
    emailInboundItem: { groupBy: jest.fn(async () => []) },
    channel: { findMany: jest.fn(async () => []) },
    ...over.prisma,
  };
  const budget = {
    platformUsage: jest.fn(async () => ({ day: '2026-09-22', limit: 5000, used: 640 })),
    breakdown: jest.fn(async () => [
      { workspaceId: 'ws-1', used: 600 },
      { workspaceId: 'ws-2', used: 40 },
    ]),
    caps: jest.fn(() => ({ workspace: 1000, platform: 5000 })),
    ...over.budget,
  };
  return { prisma, budget, svc: new MailAdminService(prisma, budget as any) };
}

describe('MailAdminService.overview', () => {
  it('shows today per tenant against both ceilings, busiest first', async () => {
    const { svc } = build();
    const out = await svc.overview({ now: NOW });

    expect(out.day).toBe('2026-09-22');
    expect(out.platform).toEqual({ limit: 5000, used: 640 });
    expect(out.workspaces.map((w) => w.workspaceId)).toEqual(['ws-1', 'ws-2']);
    expect(out.workspaces[0]).toMatchObject({
      workspaceId: 'ws-1',
      name: 'Acme',
      used: 600,
      cap: 1000,
      paused: false,
    });
    expect(out.workspaces[1].paused).toBe(true);
  });

  it('counts every tenant day from the ledger in one grouped read', async () => {
    const { svc, prisma } = build();
    prisma.mailLog.groupBy.mockImplementation(async (args: any) =>
      args.by?.includes('status')
        ? counted([
            { workspaceId: 'ws-1', status: 'SENT', _n: 500 },
            { workspaceId: 'ws-1', status: 'FAILED_PERMANENT', _n: 100 },
            { workspaceId: 'ws-2', status: 'REFUSED', _n: 4 },
          ])
        : counted([{ workspaceId: 'ws-1', _n: 9 }]),
    );

    const out = await svc.overview({ now: NOW });

    expect(out.workspaces[0]).toMatchObject({ sent: 500, failed: 100, refused: 0, bounced: 9 });
    expect(out.workspaces[1]).toMatchObject({ sent: 0, failed: 0, refused: 4, bounced: 0 });
    // One pass over the ledger for the whole console, keyed on the UTC day.
    expect(prisma.mailLog.groupBy.mock.calls[0][0].where.createdAt.gte).toEqual(DAY_START);
  });

  it('counts mailboxes, how many are proven, and surfaces the newest error', async () => {
    const { svc, prisma } = build();
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'ch-1',
        workspaceId: 'ws-1',
        name: 'Destek',
        lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
        configPublic: {
          health: {
            receive: {
              ok: false,
              reason: 'AUTH_FAILED',
              lastError: 'AUTHENTICATIONFAILED',
              lastErrorAt: '2026-09-22T09:00:00.000Z',
            },
          },
        },
      },
      {
        id: 'ch-2',
        workspaceId: 'ws-1',
        name: 'Satış',
        lastVerifiedAt: null,
        configPublic: {
          health: {
            send: { ok: false, reason: 'OAUTH_REAUTH_REQUIRED', lastError: 'invalid_grant', lastErrorAt: '2026-09-22T11:00:00.000Z' },
          },
        },
      },
    ]);

    const out = await svc.overview({ now: NOW });

    expect(out.workspaces[0]).toMatchObject({ mailboxes: 2, provenMailboxes: 1 });
    expect(out.workspaces[0].lastError).toMatchObject({
      channelId: 'ch-2',
      lane: 'send',
      reason: 'OAUTH_REAUTH_REQUIRED',
      at: '2026-09-22T11:00:00.000Z',
    });
  });

  it('reports the standing quarantine per tenant', async () => {
    const { svc, prisma } = build();
    prisma.emailInboundItem.groupBy.mockResolvedValue(counted([{ workspaceId: 'ws-2', _n: 5 }]));
    const out = await svc.overview({ now: NOW });
    expect(out.workspaces.find((w) => w.workspaceId === 'ws-2')!.quarantined).toBe(5);
  });

  it('names the env-gated features the deployment leaves inert', async () => {
    const { svc } = build();
    const out = await svc.overview({ now: NOW, env: {} });
    expect(out.inert.some((f) => f.key === 'ESP_FEEDBACK')).toBe(true);
  });

  it('answers with what it could read instead of throwing', async () => {
    const { svc, prisma } = build();
    prisma.mailLog.groupBy.mockRejectedValue(new Error('P2024 pool timeout'));
    const out = await svc.overview({ now: NOW });
    expect(out.partial).toBe(true);
    expect(out.workspaces[0].sent).toBe(0);
  });
});

describe('MailAdminService.setPaused', () => {
  it('flips settings.email.paused without touching the rest of the settings', async () => {
    const { svc, prisma } = build();
    await expect(svc.setPaused('ws-1', true)).resolves.toEqual({ workspaceId: 'ws-1', paused: true });

    const [args] = prisma.workspace.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'ws-1' });
    expect(args.data.settings).toEqual({ brand: 'keep me', email: { paused: true } });
  });

  it('keeps the other email settings when it unpauses', async () => {
    const { svc, prisma } = build();
    prisma.workspace.findFirst.mockResolvedValue({
      settings: { email: { paused: true, requireConsent: true } },
    });

    await svc.setPaused('ws-1', false);

    expect(prisma.workspace.update.mock.calls[0][0].data.settings).toEqual({
      email: { paused: false, requireConsent: true },
    });
  });

  it('refuses a workspace that is not there rather than creating one', async () => {
    const { svc, prisma } = build();
    prisma.workspace.findFirst.mockResolvedValue(null);
    await expect(svc.setPaused('nope', true)).rejects.toThrow(/not found/i);
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });
});
