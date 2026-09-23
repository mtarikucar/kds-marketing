/**
 * The inbound half of email, for every workspace that has a mailbox and no ESP.
 *
 * Only the NETWORK is faked here. `mailparser`, `classifyMail` and
 * `EmailChannelAdapter` are the real ones, so these tests exercise the actual
 * MIME decoding, the actual machine-mail rules and the actual echo/shape rules
 * rather than a second implementation of them written to agree with the first.
 *
 * The cursor tests are the heart of the file. "Never lose mail" is not a
 * property you can see by reading `drain()` — it is the conjunction of four
 * behaviours (a throw holds the cursor, a deliberate skip advances it, a
 * deterministic failure advances immediately, and a poison uid is escaped after
 * a bounded number of attempts), and each of them breaks the other three if it
 * is written alone.
 */
import { Readable } from 'stream';

const mockImap: any = {
  opts: null,
  lockPath: null,
  lockOptions: null,
  mailbox: { uidValidity: 42n, uidNext: 101 },
  search: jest.fn(),
  fetchOne: jest.fn(),
  download: jest.fn(),
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
      download: mockImap.download,
    };
  }),
}));

import { EmailImapPollService } from './email-imap-poll.service';
import { EmailChannelAdapter } from './adapters/email.adapter';
// The real detector, not a restatement of it: what makes a leaked quote
// expensive is that OUR OWN footer reads as the customer opting out.
import { detectOptOut } from './inbound/optout-keywords';

const WS = 'ws-1';
const CH_ID = 'ch-1';
const OWN = 'admin@hummytummy.com';
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** What a server returns for `{ headers: true }` — the block, nothing after it. */
function headerBlockOf(source: string): string {
  const end = source.indexOf('\r\n\r\n');
  return end < 0 ? source : source.slice(0, end + 4);
}

/** The receive-lane health writer, recording what the sweep decided. Optional
 *  in the service, so a test that does not care simply leaves it out. */
function healthMock() {
  return {
    recordOk: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordBackoff: jest
      .fn()
      .mockResolvedValue({ failCount: 1, backoffUntil: new Date(Date.now() + 60_000) }),
  };
}

/**
 * The `configPublic` PATCH a cursor write hands the database.
 *
 * The write is one `configPublic || $patch` statement, so the keys it names
 * are the only ones it can touch — the Sent reconciler's cursor, the health
 * block and the tenant's settings all live in the same column and are written
 * by things this tick is not serialized against.
 */
function cursorPatch(prisma: any, index = 0): any {
  const calls = prisma.$executeRaw.mock.calls;
  const call = index < 0 ? calls.at(index) : calls[index];
  const json = (call[0].values as unknown[]).find(
    (v) => typeof v === 'string' && (v as string).startsWith('{'),
  );
  return JSON.parse(json as string);
}

function build(
  over: {
    secrets?: Record<string, any>;
    configPublic?: any;
    channels?: any[];
    items?: any;
    health?: any;
  } = {},
) {
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
    // The REPLIES_AND_KNOWN lookups. Every one answers "never heard of them"
    // by default, so a test that wants a sender recognised says which way.
    workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    mailLog: { findFirst: jest.fn().mockResolvedValue(null) },
    contactIdentity: { findFirst: jest.fn().mockResolvedValue(null) },
    lead: { findFirst: jest.fn().mockResolvedValue(null) },
    // The cursor write: ONE `configPublic || $patch` statement, so the keys it
    // names are the only ones it can touch. (`withAdvisoryLock` uses
    // `$queryRaw`, so this mock sees cursor writes and nothing else.)
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const registry: any = {
    has: jest.fn().mockReturnValue(true),
    get: jest
      .fn()
      .mockReturnValue(
        new EmailChannelAdapter({ register: jest.fn() } as any, { refreshNow: jest.fn() } as any),
      ),
    resolveConfig: jest.fn((ch: any) => ({
      secrets: ch.id === CH_ID ? secrets : GODADDY,
      public: {},
      externalId: ch.externalId,
    })),
  };
  const ingress: any = { ingest: jest.fn().mockResolvedValue({ deduped: false }) };
  const suppression: any = { suppress: jest.fn().mockResolvedValue(undefined) };
  const health = over.health;
  return {
    prisma,
    registry,
    ingress,
    suppression,
    items: over.items,
    health,
    svc: new EmailImapPollService(prisma, registry, ingress, suppression, over.items, health),
  };
}

/** A ledger that records everything and answers like package 28's service. */
function ledger() {
  return {
    open: jest.fn().mockResolvedValue({ id: 'it-1' }),
    done: jest.fn().mockResolvedValue(undefined),
    skipped: jest.fn().mockResolvedValue(undefined),
    failed: jest.fn().mockResolvedValue({ id: 'it-1', state: 'FAILED', attempts: 1 }),
    registerReplayer: jest.fn(),
  };
}

/**
 * fetchOne is asked three different questions: the size/date head, the whole
 * source, and — on the oversize path only — the headers plus the body
 * structure. Serving them separately is what lets a test assert that the
 * source was never pulled.
 */
function serveOne(
  source: string,
  over: { size?: number; internalDate?: Date; bodyStructure?: any } = {},
) {
  const size = over.size ?? source.length;
  const internalDate = over.internalDate ?? new Date();
  mockImap.fetchOne.mockImplementation(async (_uid: string, query: any) => {
    if (query?.source) return { size, internalDate, source: Buffer.from(source, 'utf8') };
    if (query?.headers) {
      return {
        size,
        internalDate,
        headers: Buffer.from(headerBlockOf(source), 'utf8'),
        bodyStructure: over.bodyStructure ?? null,
      };
    }
    return { size, internalDate };
  });
}

const PDF_PART = {
  part: '2',
  type: 'application/pdf',
  disposition: 'attachment',
  dispositionParameters: { filename: 'sozlesme.pdf' },
  size: 2_900_000,
};
const JPG_PART = {
  part: '3',
  type: 'image/jpeg',
  disposition: 'attachment',
  dispositionParameters: { filename: 'dekont.jpg' },
  size: 900_000,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockImap.mailbox = { uidValidity: 42n, uidNext: 101 };
  mockImap.connectThrows = null;
  mockImap.connects = 0;
  mockImap.logouts = 0;
  mockImap.search.mockResolvedValue([]);
  mockImap.fetchOne.mockResolvedValue(null);
  mockImap.download.mockResolvedValue({});
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
    expect(mockImap.opts).toMatchObject({ host: 'imap.custom.example', port: 994, secure: true });
    // 994 is implicit TLS, so asking for an upgrade on top would be wrong.
    expect(mockImap.opts).not.toHaveProperty('doSTARTTLS');
  });

  it('demands a STARTTLS upgrade on the plaintext IMAP port', async () => {
    // `secure: true` on 143 fails every poll against a 143-only server, and
    // without `doSTARTTLS` imapflow falls back to OPPORTUNISTIC STARTTLS —
    // which sends LOGIN in cleartext to a server that has none.
    const { svc } = build({
      secrets: { ...GODADDY, imapHost: 'imap.tiny-host.example', imapPort: '143' },
    });
    await svc.poll();
    expect(mockImap.opts).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
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
    expect(cursorPatch(prisma)).toMatchObject({ imapLastUid: 91, imapUidValidity: '42' });
  });

  it('writes its OWN keys and nothing else — the column has other writers', async () => {
    // `configPublic` carries the Sent reconciler's cursor, the mailbox health
    // block and the tenant's settings, and nothing serializes those against
    // this tick. A read-modify-write of the whole blob would silently revert
    // whichever of them committed while this tick held its copy, so the write
    // names five keys and the database merges them onto the row as it stands.
    const { svc, prisma } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();

    expect(Object.keys(cursorPatch(prisma)).sort()).toEqual([
      'imapFailCount',
      'imapFailUid',
      'imapFailUidValidity',
      'imapLastUid',
      'imapUidValidity',
    ]);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('writes the cursor scoped to the workspace, as every channel write is', async () => {
    const { svc, prisma } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();

    const stmt = prisma.$executeRaw.mock.calls[0][0];
    expect(stmt.sql).toContain('"workspaceId"');
    expect(stmt.values).toContain(WS);
    expect(stmt.values).toContain(CH_ID);
  });
});

describe('EmailImapPollService — a throw must not lose the mail', () => {
  const RESUMED = { imapLastUid: 90, imapUidValidity: '42' };

  function transient(): Error {
    return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  }

  it('holds the cursor at the last uid it actually finished', async () => {
    // A socket drop or a DB timeout mid-batch used to skip up to fifty
    // customer replies permanently: the cursor advanced BEFORE the ingest ran.
    const { svc, prisma, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91, 92]);
    serveOne(rfc822());
    ingress.ingest.mockRejectedValueOnce(transient());

    await svc.poll();

    const written = cursorPatch(prisma);
    expect(written.imapLastUid).toBe(90);
    // and it STOPS: draining on would leave 91 behind a cursor that has moved.
    expect(ingress.ingest).toHaveBeenCalledTimes(1);
  });

  it('counts the failure against that one uid, keyed to the mailbox generation', async () => {
    const { svc, prisma, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    ingress.ingest.mockRejectedValueOnce(transient());

    await svc.poll();

    expect(cursorPatch(prisma)).toMatchObject({
      imapFailUid: 91,
      imapFailUidValidity: '42',
      imapFailCount: 1,
    });
  });

  it('advances past a uid that has already burnt its attempts, on the fourth', async () => {
    // Head-of-line blocking is the real risk of stopping. One malformed
    // message must not freeze every later reply to that mailbox forever.
    const { svc, prisma, ingress } = build({
      configPublic: { ...RESUMED, imapFailUid: 91, imapFailUidValidity: '42', imapFailCount: 3 },
    });
    mockImap.search.mockResolvedValue([91, 92]);
    serveOne(rfc822());
    ingress.ingest.mockRejectedValueOnce(transient());

    await svc.poll();

    const written = cursorPatch(prisma);
    expect(written.imapLastUid).toBe(92);
    expect(written.imapFailUid).toBeNull();
    expect(written.imapFailCount).toBeNull();
    // 92 was still drained — escaping the poison is not a reason to stop.
    expect(ingress.ingest).toHaveBeenCalledTimes(2);
  });

  it('clears the counter as soon as the uid succeeds', async () => {
    const { svc, prisma } = build({
      configPublic: { ...RESUMED, imapFailUid: 91, imapFailUidValidity: '42', imapFailCount: 2 },
    });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());

    await svc.poll();

    expect(cursorPatch(prisma)).toMatchObject({
      imapLastUid: 91,
      imapFailUid: null,
      imapFailCount: null,
    });
  });

  it('keeps a FIRST run inside its lookback window even when its first mail throws', async () => {
    // The cursor only moves on a uid that finished, so a zero written here
    // would make the next tick resume from `1:*` and walk the whole mailbox —
    // the exact history swallow the lookback window exists to prevent.
    const { svc, prisma, ingress } = build({ configPublic: null });
    mockImap.search.mockResolvedValue([610, 611]);
    serveOne(rfc822());
    ingress.ingest.mockRejectedValueOnce(transient());

    await svc.poll();

    expect(cursorPatch(prisma)).toMatchObject({
      imapLastUid: 609,
      imapFailUid: 610,
    });
  });

  it('does not burn three ticks on a failure that cannot succeed later', async () => {
    // A malformed MIME body parses the same way every time. Retrying it costs
    // fifteen minutes of inbound latency for every message behind it.
    const { svc, prisma, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91, 92]);
    const internalDate = new Date();
    mockImap.fetchOne.mockImplementation(async (_uid: string, query: any) => {
      if (query?.source) {
        return {
          size: 100,
          internalDate,
          source: Readable.from(
            (async function* () {
              throw new Error('unparseable MIME');
            })(),
          ),
        };
      }
      return { size: 100, internalDate };
    });

    await svc.poll();

    const written = cursorPatch(prisma);
    expect(written.imapLastUid).toBe(92);
    expect(written.imapFailCount).toBeNull();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });
});

describe('EmailImapPollService — oversize and attachment-only mail', () => {
  const RESUMED = { imapLastUid: 90, imapUidValidity: '42' };

  it('ingests a 3 MB reply by downloading only its text part', async () => {
    // "signed copy attached" with a 1.8 MB PDF used to vanish: the reply never
    // appeared, the AI never answered, and follow-ups kept firing.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822(), {
      size: 3_000_000,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [{ part: '1', type: 'text/plain', size: 12_000 }, PDF_PART],
      },
    });
    mockImap.download.mockResolvedValue({ content: 'Sözleşmeyi imzaladım, ekte.' });

    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });

    expect(mockImap.download).toHaveBeenCalledWith(
      '91',
      '1',
      expect.objectContaining({ uid: true, maxBytes: 256 * 1024 }),
    );
    // The whole point: the multi-megabyte source was never pulled.
    expect(mockImap.fetchOne.mock.calls.some((c: any[]) => c[1]?.source)).toBe(false);
    const text = ingress.ingest.mock.calls[0][1].text;
    expect(text).toContain('Sözleşmeyi imzaladım');
    expect(text).toContain('sozlesme.pdf');
  });

  it('still filters an oversize newsletter on its headers alone', async () => {
    // Order is load-bearing. Mail over 1 MB is disproportionately image-heavy
    // newsletters, bounce reports and vacation auto-replies; classifying only
    // AFTER the download would recreate the lead storm the class docstring
    // records from the first live run.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ 'List-Unsubscribe': '<mailto:no@x.com>' }), {
      size: 3_000_000,
      bodyStructure: { part: '1', type: 'text/plain', size: 12_000 },
    });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(mockImap.download).not.toHaveBeenCalled();
  });

  it('never answers with silence for an attachment-only mail', async () => {
    // The AI answers whatever is ingested, so the body has to SAY the content
    // was not read. An empty message and a confident summary are both lies.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ __body: '' }), {
      size: 3_800_000,
      bodyStructure: { type: 'multipart/mixed', childNodes: [PDF_PART, JPG_PART] },
    });

    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });

    expect(mockImap.download).not.toHaveBeenCalled();
    expect(ingress.ingest.mock.calls[0][1].text).toContain(
      '[2 dosya eklendi: sozlesme.pdf, dekont.jpg — içerik okunamadı]',
    );
  });

  it('does not read a forwarded message as the sender own words', async () => {
    // A `message/rfc822` part is somebody else's mail. Descending into it
    // would attribute its text to the person who forwarded it.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ __body: '' }), {
      size: 2_000_000,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          {
            part: '1',
            type: 'message/rfc822',
            dispositionParameters: { filename: 'iletilen.eml' },
            childNodes: [{ part: '1.1', type: 'text/plain', size: 4_000 }],
          },
        ],
      },
    });

    await svc.poll();

    expect(mockImap.download).not.toHaveBeenCalled();
    expect(ingress.ingest.mock.calls[0][1].text).toContain('iletilen.eml');
  });

  it('falls back to the HTML part when there is no plain text', async () => {
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822(), {
      size: 1_400_000,
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [{ part: '2', type: 'text/html', size: 40_000 }],
      },
    });
    mockImap.download.mockResolvedValue({
      content: '<div>Merhaba,<br>yar&#305;n ar&#305;yorum.</div>',
    });

    await svc.poll();

    expect(mockImap.download).toHaveBeenCalledWith('91', '2', expect.anything());
    expect(ingress.ingest.mock.calls[0][1].text).toContain('yarın arıyorum.');
  });

  it('ingests a small attachment-only mail too, not just an oversize one', async () => {
    // A 200 KB scan is under the source cap and still carries no text. The old
    // "no body ⇒ return false" dropped it exactly as silently.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    const source =
      'From: Tarık <tarik42777@gmail.com>\r\n' +
      `To: ${OWN}\r\n` +
      'Subject: Dekont\r\n' +
      'Message-ID: <CAF999@mail.gmail.com>\r\n' +
      'Content-Type: application/pdf; name="dekont.pdf"\r\n' +
      'Content-Disposition: attachment; filename="dekont.pdf"\r\n\r\n' +
      'JVBERi0=';
    serveOne(source);

    await svc.poll();

    expect(ingress.ingest).toHaveBeenCalledTimes(1);
    expect(ingress.ingest.mock.calls[0][1].text).toContain('dekont.pdf');
    expect(ingress.ingest.mock.calls[0][1].text).toContain('içerik okunamadı');
  });
});

describe('EmailImapPollService — how old is too old', () => {
  it('skips a two-year-old message that appeared on the resume path', async () => {
    // Un-archiving three hundred mails must not trigger three hundred AI
    // replies to conversations that ended months ago.
    const { svc, prisma, ingress } = build({
      configPublic: { imapLastUid: 90, imapUidValidity: '42' },
    });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822(), { internalDate: new Date(Date.now() - 730 * DAY_MS) });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
    // The body was never pulled either — the date is known from the head fetch.
    expect(mockImap.fetchOne.mock.calls.some((c: any[]) => c[1]?.source)).toBe(false);
    expect(cursorPatch(prisma)).toMatchObject({
      imapLastUid: 91,
    });
  });

  it('still ingests it on a FIRST run, which is what connecting a mailbox means', async () => {
    const { svc, ingress } = build({ configPublic: null });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822(), { internalDate: new Date(Date.now() - 730 * DAY_MS) });

    await svc.poll();

    expect(ingress.ingest).toHaveBeenCalledTimes(1);
  });

  it('ingests when the server gave no INTERNALDATE at all', async () => {
    // Fail open. A dropped mail is silent; an old one is merely noise.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    mockImap.fetchOne.mockImplementation(async (_uid: string, query: any) =>
      query?.source ? { source: Buffer.from(rfc822(), 'utf8') } : { size: 400 },
    );

    await svc.poll();

    expect(ingress.ingest).toHaveBeenCalledTimes(1);
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

  /**
   * The HTML-only reply, which is where the quote stripping was still blind.
   *
   * `parsed.text` is synthesized by mailparser only for a root or alternative
   * HTML part. A reply carrying an inline signature logo (`multipart/related`)
   * or an attachment (`multipart/mixed`) with no `text/plain` gets neither, so
   * `bodyOf` fell through to `flattenHtml` — and flattening DESTROYS the
   * `<blockquote>` that identified the quote. The whole thread was ingested as
   * the customer's own words.
   *
   * Two costs, and the second is the expensive one: the AI reads our previous
   * message back as theirs and answers it, and the quoted BULK FOOTER — our
   * own "Abonelikten çıkmak için" / "Unsubscribe" line — matches
   * `detectOptOut`, so a customer who wrote "yes, send me a price" is
   * suppressed for good.
   */
  const htmlOnlyReply = (contentType: string) =>
    rfc822({
      'Content-Type': `${contentType}; boundary="b"`,
      __body: [
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<div>Evet, ilgileniyorum, fiyat gönderin.</div>',
        '<blockquote>',
        '<p>Hummy Tummy sonbahar kampanyası</p>',
        '<p>—<br>Abonelikten çıkmak için: https://jeeta.example/u/abc123</p>',
        '</blockquote>',
        '--b',
        'Content-Type: image/png; name="imza.png"',
        'Content-ID: <imza>',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        '--b--',
        '',
      ].join('\r\n'),
    });

  it.each(['multipart/related', 'multipart/mixed'])(
    'trims the quote out of an HTML-only %s reply, footer and all',
    async (contentType) => {
      const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
      mockImap.search.mockResolvedValue([91]);
      serveOne(htmlOnlyReply(contentType));
      await svc.poll();

      const text = ingress.ingest.mock.calls[0][1].text;
      expect(text).toContain('Evet, ilgileniyorum');
      expect(text).not.toContain('sonbahar kampanyası');
      expect(text).not.toContain('Abonelikten çıkmak için');
      // The reason it matters, asserted against the real detector rather than
      // a restatement of it: this is the sentence that suppressed the customer.
      expect(detectOptOut(text, { skipFirstLine: true }).matched).toBe(false);
    },
  );

  it('trims the quote out of an HTML-only body read SELECTIVELY, too', async () => {
    // The oversize branch downloads one part and flattens it itself. Same
    // defect, different function — a reply with a 3 MB attachment quoting the
    // campaign is exactly the shape that takes this path.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    const html = [
      '<div>Evet, ilgileniyorum, fiyat gönderin.</div>',
      '<blockquote><p>Hummy Tummy sonbahar kampanyası</p>',
      '<p>—<br>Abonelikten çıkmak için: https://jeeta.example/u/abc123</p></blockquote>',
    ].join('\n');
    serveOne(rfc822({ 'Content-Type': 'text/html; charset=utf-8', __body: html }), {
      size: 6_000_000,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [{ part: '1', type: 'text/html', size: 900 }, PDF_PART],
      },
    });
    mockImap.download.mockResolvedValue({ content: Readable.from([Buffer.from(html, 'utf8')]) });

    await svc.poll();

    const text = ingress.ingest.mock.calls[0][1].text;
    expect(text).toContain('Evet, ilgileniyorum');
    expect(text).not.toContain('Abonelikten çıkmak için');
    expect(detectOptOut(text, { skipFirstLine: true }).matched).toBe(false);
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

  it('carries the Reply-To through, so a contact-form relay can be resolved', async () => {
    // The identity override itself lives in EmailChannelAdapter.parseInbound,
    // which is the one place both inbound paths meet — but it cannot fire on a
    // field the poller never passed.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ From: 'WordPress <wordpress@site.com.tr>', 'Reply-To': 'Ayşe <ayse@gmail.com>' }));
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][1].raw).toMatchObject({
      replyTo: expect.stringContaining('ayse@gmail.com'),
    });
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

  it('skips OUR OWN product mail, which no header marks as machine mail', async () => {
    // The daily digest is addressed to the workspace owner and leaves from the
    // platform's EMAIL_FROM, so it lands in the very mailbox this poller reads.
    // On the first live run it became a lead named after the platform, with the
    // digest as its opening message. The adapter's echo guard does not help: it
    // drops the WORKSPACE's own address, not the platform's.
    const prev = process.env.EMAIL_FROM;
    process.env.EMAIL_FROM = 'Jeeta <admin@jeetagrowth.com>';
    try {
      const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
      mockImap.search.mockResolvedValue([91]);
      serveOne(rfc822({ From: 'Jeeta <admin@jeetagrowth.com>' }));
      await svc.poll();
      expect(ingress.ingest).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = prev;
    }
  });

  it.each(['notifications@canny.io', 'no-reply@stripe.com', 'noreply@github.com'])(
    'skips %s, an address that cannot receive an answer',
    async (address) => {
      const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
      mockImap.search.mockResolvedValue([91]);
      serveOne(rfc822({ From: `Service <${address}>` }));
      await svc.poll();
      expect(ingress.ingest).not.toHaveBeenCalled();
    },
  );

  it('still ingests an ordinary person whose address merely looks businesslike', async () => {
    // The guard must not swallow real replies: info@ and admin@ are how a great
    // many small businesses actually write to you.
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ From: 'Lezzet Restoran <info@lezzetrestoran.com>' }));
    await svc.poll();
    expect(ingress.ingest).toHaveBeenCalledTimes(1);
  });

  it('skips a bounce from the mail daemon', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ From: 'Mail Delivery System <MAILER-DAEMON@secureserver.net>' }));
    await svc.poll();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('caps a tick so a large backlog arrives over several ticks', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 0, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue(Array.from({ length: 120 }, (_, i) => i + 1));
    serveOne(rfc822());
    await svc.poll();
    expect(ingress.ingest).toHaveBeenCalledTimes(50);
  });
});

describe('EmailImapPollService — the ledger', () => {
  const RESUMED = { imapLastUid: 90, imapUidValidity: '42' };

  it('records every examined uid, ingested or not, keyed to the mailbox generation', async () => {
    const items = ledger();
    const { svc } = build({ configPublic: RESUMED, items });
    mockImap.search.mockResolvedValue([91, 92]);
    let n = 0;
    mockImap.fetchOne.mockImplementation(async (_uid: string, query: any) => {
      const source = n++ < 2 ? rfc822() : rfc822({ 'Auto-Submitted': 'auto-replied' });
      return query?.source
        ? { size: 400, internalDate: new Date(), source: Buffer.from(source, 'utf8') }
        : { size: 400, internalDate: new Date() };
    });

    await svc.poll();

    expect(items.open).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, channelId: CH_ID, source: 'imap', itemKey: '42:91' }),
      expect.anything(),
    );
    expect(items.done).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '42:91' }),
      expect.anything(),
    );
    expect(items.skipped).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '42:92' }),
      'auto-reply',
      expect.anything(),
    );
  });

  it('records the error, and the mail, when the ingest throws', async () => {
    const items = ledger();
    const { svc, ingress } = build({ configPublic: RESUMED, items });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    ingress.ingest.mockRejectedValueOnce(Object.assign(new Error('db timeout'), { code: 'P2024' }));

    await svc.poll();

    expect(items.failed).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '42:91' }),
      expect.stringContaining('db timeout'),
      expect.objectContaining({ fromAddress: 'tarik42777@gmail.com' }),
    );
  });

  it('never lets a ledger outage take the ingest down with it', async () => {
    const items = ledger();
    items.done.mockRejectedValue(new Error('ledger down'));
    items.open.mockRejectedValue(new Error('ledger down'));
    const { svc, ingress } = build({ configPublic: RESUMED, items });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());

    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });
    expect(ingress.ingest).toHaveBeenCalledTimes(1);
  });

  it('registers itself as the replayer for the imap source', async () => {
    // The retry job re-fetches exactly one uid, and the poller is the only
    // thing that knows how.
    const items = ledger();
    const { svc } = build({ items });
    svc.onModuleInit();
    expect(items.registerReplayer).toHaveBeenCalledWith('imap', expect.any(Function));
  });

  it('replays exactly the one uid the ledger row names, and settles it', async () => {
    const items = ledger();
    const { svc, prisma, ingress } = build({ configPublic: RESUMED, items });
    prisma.channel.findFirst.mockResolvedValue({
      id: CH_ID,
      workspaceId: WS,
      type: 'EMAIL',
      externalId: OWN,
      configSealed: 'sealed',
      configPublic: RESUMED,
    });
    serveOne(rfc822());

    await svc.replay({ id: 'it-1', workspaceId: WS, channelId: CH_ID, source: 'imap', itemKey: '42:91' });

    expect(mockImap.fetchOne.mock.calls[0][0]).toBe('91');
    expect(ingress.ingest).toHaveBeenCalledTimes(1);
    expect(items.done).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '42:91' }),
      expect.anything(),
    );
    // A replay must never move the cursor: it is a second look at one item.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('throws rather than fetch a stranger uid after the mailbox was renumbered', async () => {
    // "That uid and no other" is the whole contract, and the runner's backoff
    // is the retry schedule — swallowing this would report success for mail
    // that never landed.
    const items = ledger();
    const { svc, prisma, ingress } = build({ configPublic: RESUMED, items });
    prisma.channel.findFirst.mockResolvedValue({
      id: CH_ID,
      workspaceId: WS,
      type: 'EMAIL',
      externalId: OWN,
      configSealed: 'sealed',
      configPublic: RESUMED,
    });
    serveOne(rfc822());
    mockImap.mailbox = { uidValidity: 77n, uidNext: 101 };

    await expect(
      svc.replay({ id: 'it-1', workspaceId: WS, channelId: CH_ID, source: 'imap', itemKey: '42:91' }),
    ).rejects.toThrow(/renumbered/);
    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(mockImap.logouts).toBe(1);
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

/**
 * The retry storm, and the half of it that was never fixed.
 *
 * `EmailImapIdleService` classifies a refused password and writes a wait; this
 * poller ran every five minutes regardless, so a tenant whose password rotated
 * kept 288 rejected logins a day going at a host that locks accounts on
 * exactly that — and because `imapTarget` falls back to the SMTP credential,
 * the lockout takes outbound with it.
 *
 * The rule the whole block encodes: a WAIT is earned by the connection and by
 * nothing else, and it applies only to the unattended sweep.
 */
describe('EmailImapPollService — a mailbox that is waiting out a backoff', () => {
  const waiting = (mins: number) => ({
    health: { backoffUntil: new Date(Date.now() + mins * 60_000).toISOString() },
  });
  const waited = () => ({
    health: { backoffUntil: new Date(Date.now() - 60_000).toISOString() },
  });

  it('is not dialled at all while the wait is live', async () => {
    const { svc } = build({ configPublic: waiting(30), health: healthMock() });
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 0 });
    expect(mockImap.connects).toBe(0);
  });

  it('is dialled again the moment the wait is over', async () => {
    const { svc } = build({ configPublic: waited(), health: healthMock() });
    await svc.poll();
    expect(mockImap.connects).toBe(1);
  });

  it('counts as skipped, not failed, so one dead password cannot red the shared cron', async () => {
    // `sweepHeartbeatError` reds the job only when EVERY attempted mailbox
    // failed. A mailbox we deliberately did not attempt is not evidence of
    // anything, and a cron that is red for reasons the operator cannot act on
    // is a cron nobody looks at.
    const { svc, prisma, health } = build({ configPublic: waiting(30), health: healthMock() });
    prisma.$transaction = jest.fn(async (fn: any) =>
      fn({ $queryRaw: async () => [{ locked: true }] }),
    );
    prisma.cronHeartbeat = { upsert: jest.fn().mockResolvedValue({}) };

    await expect(svc.pollDue()).resolves.toBeUndefined();

    const beat = prisma.cronHeartbeat.upsert.mock.calls[0][0];
    expect(beat.create.lastError).toBeNull();
    expect(beat.update.lastError).toBeNull();
    // And a mailbox we never dialled is described as neither well nor ill.
    expect(health.recordOk).not.toHaveBeenCalled();
    expect(health.recordFailure).not.toHaveBeenCalled();
    expect(health.recordBackoff).not.toHaveBeenCalled();
  });

  it('earns the wait itself when the credential is refused', async () => {
    // Without this the poller could honour a wait it never writes: only the
    // IDLE hold wrote one, so a deployment whose server has no IDLE support
    // would hammer a dead password forever.
    const { svc, health } = build({ health: healthMock() });
    mockImap.connectThrows = Object.assign(new Error('Invalid credentials (Failure)'), {
      authenticationFailed: true,
    });
    await svc.poll();
    expect(health.recordBackoff).toHaveBeenCalledWith(
      { id: CH_ID, workspaceId: WS },
      expect.objectContaining({ reason: 'AUTH_FAILED', authFailure: true }),
    );
    // And the card says what actually happened, not a generic poll failure.
    expect(health.recordFailure).not.toHaveBeenCalled();
  });

  it('calls a refused socket a connect failure, not a bad password', async () => {
    const { svc, health } = build({ health: healthMock() });
    mockImap.connectThrows = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    await svc.poll();
    expect(health.recordBackoff).toHaveBeenCalledWith(
      { id: CH_ID, workspaceId: WS },
      expect.objectContaining({ reason: 'CONNECT_FAILED', authFailure: false }),
    );
  });

  it('does NOT earn a wait for a failure that came after the login', async () => {
    // A Prisma blip writing the cursor, or a mailbox lock the server refused,
    // is a transient of ours. Charging it a 1–60 minute wait would silence the
    // safety-net poll for a mailbox whose credentials are perfectly fine —
    // health state must never be the thing that stops mail arriving.
    const { svc, health } = build({ health: healthMock() });
    mockImap.search.mockRejectedValue(new Error('P2024: connection pool timeout'));
    await svc.poll();
    expect(health.recordBackoff).not.toHaveBeenCalled();
    expect(health.recordFailure).toHaveBeenCalledWith(
      { id: CH_ID, workspaceId: WS },
      'receive',
      expect.objectContaining({ reason: 'POLL_FAILED' }),
    );
  });

  it('still fetches on demand: an operator asking for this mailbox NOW is answered', async () => {
    // The wait exists to stop the unattended sweep. `pollOne` is a person, or
    // an IDLE announcement off a socket that is demonstrably alive.
    const { svc, prisma } = build({ health: healthMock() });
    prisma.channel.findFirst.mockResolvedValue({
      id: CH_ID,
      workspaceId: WS,
      type: 'EMAIL',
      externalId: OWN,
      configSealed: 'sealed',
      configPublic: waiting(30),
    });
    await expect(svc.pollOne(WS, CH_ID)).resolves.toBe(0);
    expect(mockImap.connects).toBe(1);
  });
});

describe('EmailImapPollService — who gets to become a lead', () => {
  const RESUMED = { imapLastUid: 90, imapUidValidity: '42' };

  it('lets a stranger through on a channel connected before the knob existed', async () => {
    // G3: a missing `inboundPolicy` reads as ALL_SENDERS — today's behaviour.
    // Narrowing a live shared inbox silently is what this forbids.
    const { svc, ingress, prisma } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });
    expect(ingress.ingest).toHaveBeenCalled();
    // And it costs no query at all.
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
  });

  it('records a stranger as policy-not-a-lead under REPLIES_AND_KNOWN, and does not ingest', async () => {
    const items = ledger();
    const { svc, ingress } = build({
      configPublic: { ...RESUMED, inboundPolicy: 'REPLIES_AND_KNOWN' },
      items,
    });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 1 });
    expect(ingress.ingest).not.toHaveBeenCalled();
    // Recorded, not dropped — the ledger row is what carries the one-click
    // "make this a lead", and the difference between a policy and a hole.
    expect(items.skipped).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '42:91' }),
      'policy-not-a-lead',
      expect.anything(),
    );
  });

  it('lets a known lead through under REPLIES_AND_KNOWN', async () => {
    const { svc, ingress, prisma } = build({
      configPublic: { ...RESUMED, inboundPolicy: 'REPLIES_AND_KNOWN' },
    });
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });
    expect(ingress.ingest).toHaveBeenCalled();
  });

  it('judges the RESOLVED sender, so a form relay is not judged as the website', async () => {
    const { svc, prisma } = build({
      configPublic: { ...RESUMED, inboundPolicy: 'REPLIES_AND_KNOWN' },
    });
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ From: 'WordPress <wordpress@site.com.tr>', 'Reply-To': 'Ayşe <ayse@gmail.com>' }));
    await svc.poll();
    expect(prisma.lead.findFirst.mock.calls[0][0].where.emailNormalized).toBe('ayse@gmail.com');
  });

  it('ingests anyway when the database cannot answer the policy question', async () => {
    // Fail OPEN. A transient error must not turn into a dropped customer mail.
    const { svc, ingress, prisma } = build({
      configPublic: { ...RESUMED, inboundPolicy: 'REPLIES_AND_KNOWN' },
    });
    prisma.workspaceMembership.findFirst.mockRejectedValue(new Error('P2024'));
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });
    expect(ingress.ingest).toHaveBeenCalled();
  });
});

describe('EmailImapPollService — the first tick is a backlog, not a conversation', () => {
  it('files the backlog but wakes nothing', async () => {
    // Connecting a mailbox must not answer a week of finished conversations.
    const { svc, ingress } = build();
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][2]).toEqual({ suppressAutomation: true });
  });

  it('answers normally once the mailbox has a cursor', async () => {
    const { svc, ingress } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][2]).toEqual({ suppressAutomation: false });
  });
});

describe('EmailImapPollService — a bounce in the tenant mailbox', () => {
  const DSN_BODY = [
    '--b',
    'Content-Type: text/plain',
    '',
    'Delivery has failed.',
    '--b',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mail.secureserver.net',
    '',
    'Final-Recipient: rfc822; yok@musteri.com',
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    '--b--',
  ].join('\r\n');

  const dsn = (status: string) =>
    rfc822({
      From: 'Mail Delivery System <MAILER-DAEMON@secureserver.net>',
      Subject: 'Undelivered Mail Returned to Sender',
      'Content-Type': 'multipart/report; report-type=delivery-status; boundary="b"',
      __body: DSN_BODY.replace('5.1.1', status),
    });

  /** The workspace really did mail this address — what a genuine DSN reports on. */
  function weMailed(prisma: any, address: string) {
    prisma.mailLog.findFirst.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      const wanted = (where.OR ?? [where]).some((c: any) => c?.toAddressNorm === address);
      return wanted ? { id: 'ml-1' } : null;
    });
  }

  it('suppresses the address a 5.x.x report names — the only live bounce source we have', async () => {
    const { svc, suppression, ingress, prisma } = build({
      configPublic: { imapLastUid: 90, imapUidValidity: '42' },
    });
    weMailed(prisma, 'yok@musteri.com');
    mockImap.search.mockResolvedValue([91]);
    serveOne(dsn('5.1.1'));
    await svc.poll();
    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'yok@musteri.com',
      'EMAIL',
      expect.any(String),
      expect.objectContaining({ source: 'dsn' }),
    );
    // A bounce is not a lead.
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('suppresses nobody on a 4.x.x — that is a full mailbox, not a dead address', async () => {
    const { svc, suppression } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
    mockImap.search.mockResolvedValue([91]);
    serveOne(dsn('4.2.2'));
    await svc.poll();
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  /**
   * A forged report is the whole reason provenance exists.
   *
   * The tenant's mailbox address is on their website, and classification is
   * decided entirely by content the sender writes. Without a check that the
   * workspace ever mailed the named address, one email to that mailbox
   * suppresses anybody the sender chooses — their biggest customer, silently,
   * with a ledger row that says the address hard-bounced.
   */
  describe('a forged report', () => {
    it('suppresses nobody when the workspace never mailed the named address', async () => {
      const { svc, suppression, prisma } = build({
        configPublic: { imapLastUid: 90, imapUidValidity: '42' },
      });
      // The default mock already answers "never heard of them".
      mockImap.search.mockResolvedValue([91]);
      serveOne(dsn('5.1.1'));
      await svc.poll();
      expect(suppression.suppress).not.toHaveBeenCalled();
      expect(prisma.mailLog.findFirst).toHaveBeenCalled();
    });

    it('is not fooled by the bare X-Failed-Recipients shape', async () => {
      // One header on an ordinary, correctly-authenticated message from the
      // attacker's own domain is enough to classify as a bounce.
      const { svc, suppression } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
      mockImap.search.mockResolvedValue([91]);
      serveOne(
        rfc822({
          From: 'Rakip <satis@rakip.com>',
          Subject: 'merhaba',
          'X-Failed-Recipients': 'patron@buyukmusteri.com',
          __body: 'hi',
        }),
      );
      await svc.poll();
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('is not fooled by a hand-typed multipart/report either', async () => {
      // The report MIME structure is plain text an attacker writes, so
      // demoting only the legacy header shape would move the attack sideways.
      const { svc, suppression } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' } });
      mockImap.search.mockResolvedValue([91]);
      serveOne(
        rfc822({
          From: 'Rakip <mailer-daemon@rakip.com>',
          Subject: 'Undelivered Mail Returned to Sender',
          'Content-Type': 'multipart/report; report-type=delivery-status; boundary="b"',
          __body: DSN_BODY.replace('yok@musteri.com', 'patron@buyukmusteri.com'),
        }),
      );
      await svc.poll();
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('suppresses only the addresses this workspace actually mailed', async () => {
      const { svc, suppression, prisma } = build({
        configPublic: { imapLastUid: 90, imapUidValidity: '42' },
      });
      weMailed(prisma, 'yok@musteri.com');
      mockImap.search.mockResolvedValue([91]);
      serveOne(
        rfc822({
          From: 'Mail Delivery System <MAILER-DAEMON@secureserver.net>',
          Subject: 'Undelivered Mail Returned to Sender',
          'X-Failed-Recipients': 'yok@musteri.com, patron@buyukmusteri.com',
          __body: 'Delivery has failed.',
        }),
      );
      await svc.poll();
      expect(suppression.suppress).toHaveBeenCalledTimes(1);
      expect(suppression.suppress).toHaveBeenCalledWith(
        WS,
        'yok@musteri.com',
        'EMAIL',
        expect.any(String),
        expect.objectContaining({ source: 'dsn' }),
      );
    });

    it('caps how many addresses one inbound message may suppress', async () => {
      // A genuine DSN names one address, rarely a handful. An unbounded list
      // is a batch weapon, not a bounce.
      const { svc, suppression, prisma } = build({
        configPublic: { imapLastUid: 90, imapUidValidity: '42' },
      });
      prisma.mailLog.findFirst.mockResolvedValue({ id: 'ml-1' } as any);
      const many = Array.from({ length: 40 }, (_, i) => `v${i}@musteri.com`).join(', ');
      mockImap.search.mockResolvedValue([91]);
      serveOne(
        rfc822({
          From: 'Mail Delivery System <MAILER-DAEMON@secureserver.net>',
          'X-Failed-Recipients': many,
          __body: 'Delivery has failed.',
        }),
      );
      await svc.poll();
      expect(suppression.suppress.mock.calls.length).toBeLessThanOrEqual(10);
    });
  });

  it('advances the cursor even when the suppression write fails', async () => {
    // A bounce we could not file must not hold the customer mail behind it.
    const { svc, suppression, prisma } = build({
      configPublic: { imapLastUid: 90, imapUidValidity: '42' },
    });
    weMailed(prisma, 'yok@musteri.com');
    suppression.suppress.mockRejectedValue(new Error('P2024'));
    mockImap.search.mockResolvedValue([91]);
    serveOne(dsn('5.1.1'));
    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 1 });
    const written = cursorPatch(prisma, -1);
    expect(written.imapLastUid).toBe(91);
  });
});

describe('EmailImapPollService — a mail read selectively says so', () => {
  it('marks an oversize ingest oversize-truncated on its ledger row', async () => {
    // "We have the text and named the attachments" is a different answer from
    // "we have all of this", and the byte size only ever reached a warn line.
    const items = ledger();
    const { svc } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' }, items });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822(), {
      size: 3_000_000,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', size: 12_000 },
          PDF_PART,
        ],
      },
    });
    mockImap.download.mockResolvedValue({ content: Buffer.from('Sözleşme ektedir.', 'utf8') });

    await svc.poll();

    expect(items.done).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '42:91' }),
      expect.anything(),
      'oversize-truncated',
    );
  });

  it('leaves an ordinary ingest unmarked', async () => {
    const items = ledger();
    const { svc } = build({ configPublic: { imapLastUid: 90, imapUidValidity: '42' }, items });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();
    expect(items.done).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });
});

describe('EmailImapPollService — what the transport could prove', () => {
  const RESUMED = { imapLastUid: 90, imapUidValidity: '42' };

  it('carries an authentication FAILURE all the way to the ingress', () => {
    // The verdict is computed here, mapped by the adapter and acted on by the
    // ingress — three files, and it was silently dropped between the first
    // two. This is the whole wire in one assertion.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(
      rfc822({
        'Authentication-Results': 'mx.acme.test; spf=fail smtp.mailfrom=x; dkim=fail; dmarc=fail',
      }),
    );
    return svc.poll().then(() => {
      // Still ingested and still attached to the lead — only the automation
      // downstream is held. Silence is the failure mode being removed.
      expect(ingress.ingest).toHaveBeenCalled();
      expect(ingress.ingest.mock.calls[0][1].senderVerified).toBe(false);
    });
  });

  it('leaves it UNSET for ordinary mail nobody authenticated', async () => {
    // Almost all mail is in this state, and it must behave exactly as it
    // always has — `undefined`, never a collapsed `false`.
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822());
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][1].senderVerified).toBeUndefined();
  });

  it('does not let a softfail alone condemn a sender', async () => {
    const { svc, ingress } = build({ configPublic: RESUMED });
    mockImap.search.mockResolvedValue([91]);
    serveOne(rfc822({ 'Authentication-Results': 'mx.acme.test; spf=softfail; dkim=pass' }));
    await svc.poll();
    expect(ingress.ingest.mock.calls[0][1].senderVerified).not.toBe(false);
  });
});
