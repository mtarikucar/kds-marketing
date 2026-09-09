/**
 * The fast path. A five-minute poll is what a customer experiences as "nothing
 * happened" — measured on a real thread: a reply sent after 20:45 appeared at
 * 20:50:02, on the tick. IDLE lets the SERVER speak first.
 *
 * Only the socket is faked. Everything about WHICH mailbox gets held, when a
 * connection is let go, and what an announcement actually triggers is the real
 * code.
 */
const mockClients: any[] = [];

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts: any) => {
    const handlers: Record<string, ((...a: any[]) => void)[]> = {};
    const client: any = {
      opts,
      handlers,
      mailboxOpenArgs: null,
      loggedOut: false,
      on: (ev: string, fn: any) => {
        (handlers[ev] ??= []).push(fn);
        return client;
      },
      emit: (ev: string, ...a: any[]) => (handlers[ev] ?? []).forEach((f) => f(...a)),
      connect: jest.fn(async () => undefined),
      mailboxOpen: jest.fn(async (path: string, o: any) => {
        client.mailboxOpenArgs = [path, o];
      }),
      logout: jest.fn(async () => {
        client.loggedOut = true;
      }),
    };
    mockClients.push(client);
    return client;
  }),
}));

import { EmailImapIdleService } from './email-imap-idle.service';

const GODADDY = {
  smtpHost: 'smtpout.secureserver.net',
  smtpUser: 'admin@own.com',
  smtpPass: 'pw',
};

function build(channels: any[], secretsFor?: (id: string) => any) {
  const prisma: any = { channel: { findMany: jest.fn().mockResolvedValue(channels) } };
  const registry: any = {
    resolveConfig: jest.fn((ch: any) => ({ secrets: secretsFor ? secretsFor(ch.id) : GODADDY })),
  };
  const poller = { pollOne: jest.fn().mockResolvedValue(1) };
  return { prisma, poller, svc: new EmailImapIdleService(prisma, registry, poller as any) };
}

const channel = (over: any = {}) => ({
  id: 'ch-1',
  workspaceId: 'ws-1',
  type: 'EMAIL',
  externalId: 'a@b.com',
  configSealed: 's',
  configPublic: null,
  ...over,
});

beforeEach(() => {
  mockClients.length = 0;
  jest.clearAllMocks();
});

describe('EmailImapIdleService — which mailboxes it holds', () => {
  it('holds a connection for a verified mailbox', async () => {
    const { svc } = build([channel()]);
    await svc.reconcile();
    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].opts).toMatchObject({
      host: 'imap.secureserver.net',
      port: 993,
      secure: true,
    });
  });

  it('asks only for mailboxes whose credentials have PASSED a health check', async () => {
    const { svc, prisma } = build([channel()]);
    await svc.reconcile();
    expect(prisma.channel.findMany.mock.calls[0][0].where).toEqual({
      type: 'EMAIL',
      status: 'ACTIVE',
      lastVerifiedAt: { not: null },
    });
  });

  it('opens INBOX READ-ONLY — a human reads this inbox', async () => {
    const { svc } = build([channel()]);
    await svc.reconcile();
    expect(mockClients[0].mailboxOpenArgs).toEqual(['INBOX', { readOnly: true }]);
  });

  it('holds nothing for a consent-connected mailbox', async () => {
    // Those tokens belong to EmailOAuthRefreshCron, exactly as in the poller.
    const { svc } = build([channel()], () => ({ oauthProvider: 'GOOGLE', fromEmail: 'a@b.com' }));
    await svc.reconcile();
    expect(mockClients).toHaveLength(0);
  });

  it('holds nothing for a provider it does not recognise', async () => {
    const { svc } = build([channel()], () => ({ ...GODADDY, smtpHost: 'mail.unknown.example' }));
    await svc.reconcile();
    expect(mockClients).toHaveLength(0);
  });

  it('does not open a SECOND connection for a mailbox it already holds', async () => {
    const { svc } = build([channel()]);
    await svc.reconcile();
    await svc.reconcile();
    await svc.reconcile();
    expect(mockClients).toHaveLength(1);
  });

  it('lets go of a mailbox that stops being eligible', async () => {
    // Disabled, unverified or deleted. A socket must not outlive the reason
    // it was opened.
    const prisma: any = {
      channel: { findMany: jest.fn().mockResolvedValueOnce([channel()]).mockResolvedValue([]) },
    };
    const svc = new EmailImapIdleService(
      prisma,
      { resolveConfig: () => ({ secrets: GODADDY }) } as any,
      { pollOne: jest.fn() } as any,
    );
    await svc.reconcile();
    await svc.reconcile();
    expect(mockClients[0].logout).toHaveBeenCalled();
  });

  it('drops a dead socket so the next reconcile retries it', async () => {
    // Registered before connect on purpose: a socket that dies during the
    // handshake must still leave the map, or it is never retried.
    const { svc } = build([channel()]);
    await svc.reconcile();
    mockClients[0].emit('close');
    await svc.reconcile();
    expect(mockClients).toHaveLength(2);
  });

  it('lets go of everything on shutdown', async () => {
    const { svc } = build([channel()]);
    await svc.reconcile();
    await svc.onModuleDestroy();
    expect(mockClients[0].logout).toHaveBeenCalled();
  });
});

describe('EmailImapIdleService — what an announcement does', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fetches the mailbox, workspace-scoped, when the server says mail landed', async () => {
    const { svc, poller } = build([channel()]);
    await svc.reconcile();
    mockClients[0].emit('exists');
    jest.advanceTimersByTime(1500);
    expect(poller.pollOne).toHaveBeenCalledWith('ws-1', 'ch-1');
  });

  it('collapses a burst into ONE fetch', async () => {
    // A server can announce several messages in a row; each announcement
    // opening its own connection is how a busy mailbox becomes a login flood.
    const { svc, poller } = build([channel()]);
    await svc.reconcile();
    mockClients[0].emit('exists');
    mockClients[0].emit('exists');
    mockClients[0].emit('exists');
    jest.advanceTimersByTime(1500);
    expect(poller.pollOne).toHaveBeenCalledTimes(1);
  });

  it('does not fetch before the burst has settled', async () => {
    const { svc, poller } = build([channel()]);
    await svc.reconcile();
    mockClients[0].emit('exists');
    jest.advanceTimersByTime(200);
    expect(poller.pollOne).not.toHaveBeenCalled();
  });

  it('does not fetch on an announcement that arrives during shutdown', async () => {
    const { svc, poller } = build([channel()]);
    await svc.reconcile();
    await svc.onModuleDestroy();
    mockClients[0].emit('exists');
    jest.advanceTimersByTime(1500);
    expect(poller.pollOne).not.toHaveBeenCalled();
  });
});
