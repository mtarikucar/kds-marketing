/**
 * The fast path. A five-minute poll is what a customer experiences as "nothing
 * happened" — measured on a real thread: a reply sent after 20:45 appeared at
 * 20:50:02, on the tick. IDLE lets the SERVER speak first.
 *
 * Only the socket is faked. Everything about WHICH mailbox gets held, when a
 * connection is let go, what an announcement actually triggers and how a
 * failing login is backed off is the real code.
 */
const mockClients: any[] = [];
/** Set by a test to make the handshake fail, or hang until it says otherwise. */
let connectImpl: (() => Promise<void>) | null = null;
let mailboxOpenImpl: (() => Promise<void>) | null = null;

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
      connect: jest.fn(async () => {
        if (connectImpl) await connectImpl();
      }),
      mailboxOpen: jest.fn(async (path: string, o: any) => {
        if (mailboxOpenImpl) await mailboxOpenImpl();
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

const MINUTE = 60_000;

function buildHealth() {
  return {
    recordOk: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordBackoff: jest
      .fn()
      .mockResolvedValue({ failCount: 1, backoffUntil: new Date(Date.now() + MINUTE) }),
  };
}

function build(channels: any[], secretsFor?: (id: string) => any) {
  const prisma: any = { channel: { findMany: jest.fn().mockResolvedValue(channels) } };
  const registry: any = {
    resolveConfig: jest.fn((ch: any) => ({ secrets: secretsFor ? secretsFor(ch.id) : GODADDY })),
  };
  const poller = { pollOne: jest.fn().mockResolvedValue(1) };
  const health = buildHealth();
  return {
    prisma,
    poller,
    health,
    svc: new EmailImapIdleService(prisma, registry, poller as any, health as any),
  };
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
  connectImpl = null;
  mailboxOpenImpl = null;
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

  it('negotiates STARTTLS on a plaintext port instead of assuming implicit TLS', async () => {
    // Via the shared resolver, so this and the poller cannot drift.
    const { svc } = build([channel()], () => ({
      ...GODADDY,
      imapHost: 'imap.tiny-host.example',
      imapPort: '143',
    }));
    await svc.reconcile();
    expect(mockClients[0].opts).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
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
      buildHealth() as any,
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

describe('EmailImapIdleService — a failing login waits instead of storming', () => {
  const authError = () => {
    const e: any = new Error('Invalid credentials (Failure)');
    e.authenticationFailed = true;
    return e;
  };

  it('records the failure, with the server own words, and earns a wait', async () => {
    // A password changed at the provider used to be ~1,700 failed logins a
    // day, which gets the whole account locked — SMTP included.
    connectImpl = async () => {
      throw authError();
    };
    const { svc, health } = build([channel()]);
    await svc.reconcile();
    expect(health.recordBackoff).toHaveBeenCalledWith(
      { id: 'ch-1', workspaceId: 'ws-1' },
      expect.objectContaining({
        authFailure: true,
        reason: 'AUTH_FAILED',
        error: expect.stringContaining('Invalid credentials'),
      }),
    );
  });

  it('does not attempt a login while the wait stands', async () => {
    const { svc } = build([
      channel({ configPublic: { health: { backoffUntil: new Date(Date.now() + 5 * MINUTE).toISOString() } } }),
    ]);
    await svc.reconcile();
    expect(mockClients).toHaveLength(0);
  });

  it('tries again once the wait has run out, and a good hold clears it', async () => {
    // Never "stop until someone clicks Verify": a transient
    // AUTHENTICATIONFAILED would otherwise kill inbound permanently.
    const { svc, health } = build([
      channel({ configPublic: { health: { backoffUntil: new Date(Date.now() - MINUTE).toISOString() } } }),
    ]);
    await svc.reconcile();
    expect(mockClients).toHaveLength(1);
    expect(health.recordOk).toHaveBeenCalledWith({ id: 'ch-1', workspaceId: 'ws-1' }, 'receive');
  });

  it('does not let go of a working hold because a wait was written elsewhere', async () => {
    // The poller writes the same backoff. A live socket is proof the mailbox
    // answers; dropping it would make the fast path worse than the bug.
    const prisma: any = {
      channel: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([channel()])
          .mockResolvedValue([
            channel({ configPublic: { health: { backoffUntil: new Date(Date.now() + 5 * MINUTE).toISOString() } } }),
          ]),
      },
    };
    const svc = new EmailImapIdleService(
      prisma,
      { resolveConfig: () => ({ secrets: GODADDY }) } as any,
      { pollOne: jest.fn() } as any,
      buildHealth() as any,
    );
    await svc.reconcile();
    await svc.reconcile();
    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].logout).not.toHaveBeenCalled();
  });

  it('a dropped IDLE socket is routine — it costs no wait at all', async () => {
    // The class docstring says drops are expected. Counting them would back a
    // perfectly healthy mailbox behind a middlebox off to the hour ceiling and
    // silently degrade the fast path into the five-minute poll.
    const { svc, health } = build([channel()]);
    await svc.reconcile();
    mockClients[0].emit('close');
    await svc.reconcile();
    expect(mockClients).toHaveLength(2);
    expect(health.recordBackoff).not.toHaveBeenCalled();
  });

  it('lets go of the socket when the mailbox cannot be opened', async () => {
    // Connected but INBOX refused: without the logout the connection is leaked
    // for as long as the mail host tolerates it, every single minute.
    mailboxOpenImpl = async () => {
      throw new Error('Mailbox does not exist');
    };
    const { svc, health } = build([channel()]);
    await svc.reconcile();
    expect(mockClients[0].logout).toHaveBeenCalled();
    expect(health.recordBackoff).toHaveBeenCalledWith(
      { id: 'ch-1', workspaceId: 'ws-1' },
      expect.objectContaining({ authFailure: false, reason: 'CONNECT_FAILED' }),
    );
  });

  it('one mailbox failing does not stop the next one being held', async () => {
    const { svc } = build([channel(), channel({ id: 'ch-2' })], (id) =>
      id === 'ch-1' ? { ...GODADDY, imapHost: 'broken.example' } : GODADDY,
    );
    connectImpl = async function (this: void) {
      const client = mockClients[mockClients.length - 1];
      if (client.opts.host === 'broken.example') throw new Error('ECONNREFUSED');
    };
    await svc.reconcile();
    expect(mockClients).toHaveLength(2);
    expect(mockClients[1].mailboxOpenArgs).toEqual(['INBOX', { readOnly: true }]);
  });
});

describe('EmailImapIdleService — overlapping reconciles', () => {
  it('two runs at once open ONE connection', async () => {
    // The tick is every minute and a dead host takes 20 seconds to answer, so
    // runs DO overlap in production. Without the guard each overlapping run
    // opens another socket for the same mailbox and none of them is tracked.
    let release!: () => void;
    const handshake = new Promise<void>((r) => (release = r));
    connectImpl = () => handshake;

    const { svc } = build([channel()]);
    const first = svc.reconcile();
    const second = svc.reconcile();
    release();
    await Promise.all([first, second]);

    expect(mockClients).toHaveLength(1);
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
