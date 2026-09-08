/**
 * The inbound half of email, for every workspace that has a mailbox and no ESP.
 *
 * Only the NETWORK is faked here. `mailparser` and `EmailChannelAdapter` are
 * the real ones, so these tests exercise the actual MIME decoding and the
 * actual echo/shape rules rather than a second implementation of them written
 * to agree with the first.
 */
const mockImap: any = {
  opts: null,
  lockPath: null,
  lockOptions: null,
  mailbox: { uidValidity: 42n, uidNext: 101 },
  search: jest.fn(),
  fetchOne: jest.fn(),
  connects: 0,
  logouts: 0,
  connectThrows: null as Error | null,
};

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts: any) => {
    mockImap.opts = opts;
    return {
      connect: jest.fn(async () => {
        if (mockImap.connectThrows) throw mockImap.connectThrows;
        mockImap.connects++;
      }),
      logout: jest.fn(async () => {
        mockImap.logouts++;
      }),
      getMailboxLock: jest.fn(async (path: string, o: any) => {
        mockImap.lockPath = path;
        mockImap.lockOptions = o;
        return { release: jest.fn() };
      }),
      get mailbox() {
        return mockImap.mailbox;
      },
      search: mockImap.search,
      fetchOne: mockImap.fetchOne,
    };
  }),
}));

import { EmailImapPollService } from './email-imap-poll.service';
import { EmailChannelAdapter } from './adapters/email.adapter';

const WS = 'ws-1';
const CH_ID = 'ch-1';
const OWN = 'admin@hummytummy.com';

const GODADDY = {
  smtpHost: 'smtpout.secureserver.net',
  smtpUser: OWN,
  smtpPass: 'pw',
  fromEmail: OWN,
};

function rfc822(over: Partial<Record<string, string>> = {}): string {
  const headers = {
    From: 'Tarık <tarik42777@gmail.com>',
    To: OWN,
    Subject: 'Re: Hummy Tummy — e-posta kanalı testi',
    'Message-ID': '<CAF123@mail.gmail.com>',
    'Content-Type': 'text/plain; charset=utf-8',
    ...over,
  };
  const body = over.__body ?? 'Evet, ilgileniyorum.\r\n\r\n> Bu mesaj panelden gönderildi.';
  return (
    Object.entries(headers)
      .filter(([k]) => k !== '__body')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') +
    '\r\n\r\n' +
    body
  );
}

function build(over: { secrets?: Record<string, any>; configPublic?: any; channels?: any[] } = {}) {
  const secrets = over.secrets ?? GODADDY;
  const channel = {
    id: CH_ID,
    workspaceId: WS,
    type: 'EMAIL',
    externalId: OWN,
    configSealed: 'sealed',
    configPublic: over.configPublic ?? null,
  };
  const channels = over.channels ?? [channel];

  const prisma: any = {
    channel: {
      findMany: jest.fn().mockResolvedValue(channels),
      findFirst: jest.fn().mockResolvedValue({ configPublic: { keepMe: true } }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const registry: any = {
    has: jest.fn().mockReturnValue(true),
    get: jest.fn().mockReturnValue(new EmailChannelAdapter({ register: jest.fn() } as any)),
    resolveConfig: jest.fn((ch: any) => ({
      secrets: ch.id === CH_ID ? secrets : GODADDY,
      public: {},
      externalId: ch.externalId,
    })),
  };
  const ingress: any = { ingest: jest.fn().mockResolvedValue({ deduped: false }) };
  return {
    prisma,
    registry,
    ingress,
    svc: new EmailImapPollService(prisma, registry, ingress),
  };
}

/** fetchOne is called twice per message: size first, then source. */
function serveOne(source: string, size = source.length) {
  mockImap.fetchOne.mockImplementation(async (_uid: string, query: any) =>
    query?.source ? { source: Buffer.from(source, 'utf8') } : { size },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockImap.mailbox = { uidValidity: 42n, uidNext: 101 };
  mockImap.connectThrows = null;
  mockImap.connects = 0;
  mockImap.logouts = 0;
  mockImap.search.mockResolvedValue([]);
  mockImap.fetchOne.mockResolvedValue(null);
});

describe('EmailImapPollService — selection', () => {
  it('polls only mailboxes whose credentials have PASSED a health check', async () => {
    // Retrying unproven credentials every five minutes against a mail host
    // that counts failed logins is how a mailbox gets locked out.
    const { svc, prisma } = build();
    await svc.poll();
    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      }),
    );
  });

  it('never connects for a consent-connected (OAuth) mailbox', async () => {
    // Those tokens belong to EmailOAuthRefreshCron. A second service
    // authenticating with them would be the only place in the module that
    // reads another service's credentials.
    const { svc } = build({ secrets: { oauthProvider: 'GOOGLE', fromEmail: OWN } });
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 0 });
    expect(mockImap.connects).toBe(0);
  });

  it('skips — rather than guesses — a provider it does not recognise', async () => {
    const { svc } = build({ secrets: { ...GODADDY, smtpHost: 'mail.some-host.example' } });
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 0 });
    expect(mockImap.connects).toBe(0);
  });

  it('derives the incoming host from the outgoing one', async () => {
    const { svc } = build();
    await svc.poll();
    expect(mockImap.opts).toMatchObject({
      host: 'imap.secureserver.net',
      port: 993,
      secure: true,
      auth: { user: OWN, pass: 'pw' },
    });
  });

  it('lets an explicit imapHost/imapPort in the channel override discovery', async () => {
    const { svc } = build({
      secrets: { ...GODADDY, imapHost: 'imap.custom.example', imapPort: '994' },
    });
    await svc.poll();
    expect(mockImap.opts).toMatchObject({ host: 'imap.custom.example', port: 994 });
  });
});

describe('EmailImapPollService — never writes to the mailbox', () => {
  it('opens INBOX read-only', async () => {
    // The whole reason the cursor lives in our database. A human reads this
    // inbox; polling must not change what their mail client shows them.
    const { svc } = build();
    await svc.poll();
    expect(mockImap.lockPath).toBe('INBOX');
    expect(mockImap.lockOptions).toMatchObject({ readOnly: true });
  });

  it('logs out even when the mailbox blows up mid-drain', async () => {
    const { svc } = build();
    mockImap.search.mockRejectedValue(new Error('server said no'));
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 0 });
    expect(mockImap.logouts).toBe(1);
  });
});

describe('EmailImapPollService — the cursor', () => {
  it('bounds the FIRST run to a lookback window instead of the whole mailbox', async () => {
    // Swallowing years of mail would create a lead per correspondent and hand
    // every one of them to the auto-reply engine.
    const { svc } = build();
    await svc.poll();
    const [query] = mockImap.search.mock.calls[0];
    expect(query.since).toBeInstanceOf(Date);
    expect(query.uid).toBeUndefined();
    expect(Date.now() - query.since.getTime()).toBeGreaterThan(23 * 3600_000);
  });

  it('resumes from the stored uid when UIDVALIDITY still matches', async () => {
    const { svc } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    await svc.poll();
    expect(mockImap.search.mock.calls[0][0]).toEqual({ uid: '91:*' });
  });

  it('drops the tail `n:*` returns when nothing is actually newer', async () => {
    // IMAP answers `91:*` with the highest existing uid even when it is below
    // 91. Without this filter every tick re-reads the last message forever.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([90]);
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('starts over when the server has renumbered the mailbox', async () => {
    // A changed UIDVALIDITY means the stored uid points at a different message
    // — or none. Reading from it would be reading from a meaningless offset.
    const { svc } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '7' } });
    await svc.poll();
    expect(mockImap.search.mock.calls[0][0].since).toBeInstanceOf(Date);
  });

  it('advances past mail it deliberately skipped', async () => {
    // Advancing only over INGESTED mail pins the cursor behind the first
    // newsletter in the box and re-reads it every five minutes, forever.
    const { svc, prisma, ingress } = build({
      configPublic: { imapLastUid: 90, imapUidValidity: '42' },
    });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ 'Auto-Submitted': 'auto-replied' }));
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(prisma.channel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { configPublic: expect.objectContaining({ imapLastUid: 91, imapUidValidity: '42' }) },
      }),
    );
  });

  it('preserves the rest of configPublic when it writes', async () => {
    const { svc, prisma } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();
    expect(prisma.channel.update.mock.calls[0][0].data.configPublic).toMatchObject({ keepMe: true });
  });

  it('re-reads the row workspace-scoped before writing the cursor', async () => {
    const { svc, prisma } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    await svc.poll();
    expect(prisma.channel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CH_ID, workspaceId: WS } }),
    );
  });
});

describe('EmailImapPollService — what reaches the conversation', () => {
  it('ingests a reply with the quoted thread trimmed off', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });

    const [channelRef, msg] = ingress.ingest.mock.calls[0];
    expect(channelRef).toEqual({ id: CH_ID, workspaceId: WS, type: 'EMAIL' });
    expect(msg.externalUserId).toBe('tarik42777@gmail.com');
    expect(msg.text).toContain('Evet, ilgileniyorum.');
    expect(msg.text).not.toContain('panelden gönderildi');
  });

  it('uses the bare Message-ID, so an ESP webhook would dedup against it', async () => {
    // An inbound-parse provider posts the id WITHOUT angle brackets. A
    // workspace that later adds an ESP briefly has both paths delivering the
    // same mail; matching ids collapse them, mismatched ids double every
    // message.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][1].externalMessageId).toBe('CAF123@mail.gmail.com');
  });

  it('decodes a quoted-printable Turkish body rather than ingesting the encoding', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(
      rfc822({
        'Content-Transfer-Encoding': 'quoted-printable',
        __body: 'Yar=C4=B1n ar=C4=B1yorum.',
      }),
    );
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][1].text).toContain('Yarın arıyorum.');
  });

  it('drops our own address, so an auto-reply cannot answer itself', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ From: `Hummy Tummy <${OWN}>` }));
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it.each([
    ['Auto-Submitted', 'auto-generated'],
    ['Precedence', 'bulk'],
    ['List-Unsubscribe', '<mailto:no@x.com>'],
  ])('skips automated mail marked by %s', async (header, value) => {
    // A bounce or an out-of-office would otherwise become a lead the AI then
    // answers — and two auto-responders introduced to each other never stop.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ [header]: value }));
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('skips a bounce from the mail daemon', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ From: 'Mail Delivery System <MAILER-DAEMON@secureserver.net>' }));
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('does not pull the body of an oversize message', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822(), 5_000_000);
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(mockImap.fetchOne).toHaveBeenCalledTimes(1); // size only, never source
  });

  it('caps a tick so a large backlog arrives over several ticks', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 0, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue(Array.from({ length: 120 }, (_, i) => i + 1));
    serveOne(rfc822());
    await svc.poll();
    expect(ingress.ingest).toHaveBeenCalledTimes(50);
  });
});

describe('EmailImapPollService — one bad mailbox', () => {
  it('does not stop the others', async () => {
    const { svc } = build({
      channels: [
        { id: CH_ID, workspaceId: WS, type: 'EMAIL', externalId: OWN, configSealed: 's', configPublic: null },
        { id: 'ch-2', workspaceId: 'ws-2', type: 'EMAIL', externalId: 'a@b.com', configSealed: 's', configPublic: null },
      ],
    });
    let first = true;
    mockImap.search.mockImplementation(async () => {
      if (first) {
        first = false;
        throw new Error('login failed');
      }
      return [];
    });
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 1 });
  });
});
