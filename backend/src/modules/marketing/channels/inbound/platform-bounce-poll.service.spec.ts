/**
 * The platform mailbox's own bounces.
 *
 * Only the NETWORK is faked here. `mailparser` and `delivery-report.ts` are the
 * real ones, so these tests exercise the actual MIME decoding and the actual
 * 5.x.x/4.x.x/MDN rules rather than a second implementation written to agree
 * with the first.
 */
const mockImap: any = {
  opts: null as any,
  lockPath: null as string | null,
  lockOptions: null as any,
  mailbox: { uidValidity: 7n, uidNext: 200 },
  search: jest.fn(),
  fetchOne: jest.fn(),
  searchQueries: [] as any[],
  constructed: 0,
  connects: 0,
  logouts: 0,
};

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation((opts: any) => {
    mockImap.opts = opts;
    mockImap.constructed++;
    return {
      connect: jest.fn(async () => {
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
      search: (q: any, o: any) => {
        mockImap.searchQueries.push(q);
        return mockImap.search(q, o);
      },
      fetchOne: mockImap.fetchOne,
    };
  }),
}));

import { Logger } from '@nestjs/common';
import { PlatformBouncePollService } from './platform-bounce-poll.service';

const CRLF = '\r\n';
const PLATFORM = 'admin@jeetagrowth.com';
const MAIL_LOG_ID = '11111111-2222-3333-4444-555555555555';
const WS = 'ws-1';
const RECIPIENT_ROW = 'rec-9';

function mime(headers: Record<string, string>, body: string): string {
  return (
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join(CRLF) +
    CRLF +
    CRLF +
    body
  );
}

/** An RFC 3464 report, assembled the way a real MTA assembles one. */
function dsn(
  over: {
    status?: string;
    recipient?: string;
    originalMessageId?: string | null;
    returnedHeaders?: string | null;
    second?: { recipient: string; status: string };
  } = {},
): string {
  const status = over.status ?? '5.1.1';
  const recipient = over.recipient ?? 'dead@example.com';
  const originalMessageId =
    over.originalMessageId === undefined ? `<${MAIL_LOG_ID}@jeetagrowth.com>` : over.originalMessageId;

  const perMessage = ['Reporting-MTA: dns; smtpout.secureserver.net'];
  if (originalMessageId) perMessage.push(`Original-Message-ID: ${originalMessageId}`);

  const blocks = [
    perMessage.join(CRLF),
    [
      `Final-Recipient: rfc822; ${recipient}`,
      'Action: failed',
      `Status: ${status}`,
      `Diagnostic-Code: smtp; 550 ${status} <${recipient}> User unknown`,
    ].join(CRLF),
  ];
  if (over.second) {
    blocks.push(
      [
        `Final-Recipient: rfc822; ${over.second.recipient}`,
        'Action: failed',
        `Status: ${over.second.status}`,
      ].join(CRLF),
    );
  }

  const parts = [
    mime({ 'Content-Type': 'text/plain; charset=utf-8' }, 'This is the mail system at host smtpout.secureserver.net.'),
    mime({ 'Content-Type': 'message/delivery-status' }, blocks.join(CRLF + CRLF)),
  ];
  if (over.returnedHeaders) {
    parts.push(mime({ 'Content-Type': 'text/rfc822-headers' }, over.returnedHeaders));
  }

  return mime(
    {
      From: 'Mail Delivery System <MAILER-DAEMON@smtpout.secureserver.net>',
      To: PLATFORM,
      Subject: 'Undelivered Mail Returned to Sender',
      'Message-ID': '<dsn-1@secureserver.net>',
      'Content-Type': 'multipart/report; report-type=delivery-status; boundary="BOUND"',
    },
    ['--BOUND', parts.join(CRLF + '--BOUND' + CRLF), '--BOUND--', ''].join(CRLF),
  );
}

/** A Yahoo-shaped ARF complaint. */
function arf(): string {
  const parts = [
    mime({ 'Content-Type': 'text/plain' }, 'This is an email abuse report.'),
    mime(
      { 'Content-Type': 'message/feedback-report' },
      [
        'Feedback-Type: abuse',
        'User-Agent: Yahoo!-Mail-Feedback/2.0',
        'Version: 1',
        'Original-Rcpt-To: angry@example.com',
        `Original-Message-ID: <${MAIL_LOG_ID}@jeetagrowth.com>`,
      ].join(CRLF),
    ),
  ];
  return mime(
    {
      From: 'complaints@yahoo.com',
      To: PLATFORM,
      Subject: 'FW: spam complaint',
      'Message-ID': '<arf-1@yahoo.com>',
      'Content-Type': 'multipart/report; report-type=feedback-report; boundary="B"',
    },
    ['--B', parts.join(CRLF + '--B' + CRLF), '--B--', ''].join(CRLF),
  );
}

/** A read receipt — the friendliest signal there is, and not a bounce. */
function mdn(): string {
  const parts = [
    mime({ 'Content-Type': 'text/plain' }, 'Your message was read.'),
    mime(
      { 'Content-Type': 'message/disposition-notification' },
      [
        'Reporting-UA: example.com; Outlook',
        'Final-Recipient: rfc822; okumus@example.com',
        `Original-Message-ID: <${MAIL_LOG_ID}@jeetagrowth.com>`,
        'Disposition: manual-action/MDN-sent-automatically; displayed',
      ].join(CRLF),
    ),
  ];
  return mime(
    {
      From: 'okumus@example.com',
      To: PLATFORM,
      Subject: 'Okundu: Teklifiniz',
      'Message-ID': '<mdn-1@example.com>',
      'Content-Type': 'multipart/report; report-type=disposition-notification; boundary="C"',
    },
    ['--C', parts.join(CRLF + '--C' + CRLF), '--C--', ''].join(CRLF),
  );
}

/**
 * A forged NDR: an ordinary mail anyone can send to the publicly known platform
 * address, carrying only the pre-RFC-3464 header that names its "victims".
 */
function forged(victims: string[]): string {
  return mime(
    {
      From: 'Mail Delivery Subsystem <MAILER-DAEMON@attacker.example>',
      To: PLATFORM,
      Subject: 'Delivery Status Notification (Failure)',
      'X-Failed-Recipients': victims.join(', '),
      'Message-ID': '<forged-1@attacker.example>',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    'Your message could not be delivered.',
  );
}

/** Somebody writing to admin@ — this poller has nothing to do with it. */
function human(): string {
  return mime(
    {
      From: 'Tarık <tarik@example.com>',
      To: PLATFORM,
      Subject: 'Merhaba',
      'Message-ID': '<human-1@example.com>',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    'Fiyat listesini gönderebilir misiniz?',
  );
}

interface Item {
  source?: string;
  size?: number;
  internalDate?: Date;
  bodyStructure?: any;
  throws?: Error;
  bodyParts?: Record<string, string>;
}

function build(items: Record<number, Item>, over: { suppress?: any; sentTo?: string } = {}) {
  const uids = Object.keys(items).map(Number).sort((a, b) => a - b);

  mockImap.search.mockImplementation(async (q: any) => {
    if (q?.uid) {
      const m = /^(\d+):\*$/.exec(String(q.uid));
      const from = m ? Number(m[1]) : 0;
      const above = uids.filter((u) => u >= from);
      // `n:*` is never empty in IMAP — the server answers with its highest uid.
      return above.length ? above : [uids[uids.length - 1] ?? 0];
    }
    return uids.slice();
  });

  mockImap.fetchOne.mockImplementation(async (uid: string, query: any) => {
    const item = items[Number(uid)];
    if (!item) return null;
    if (item.throws) throw item.throws;
    if (query?.source) return { uid: Number(uid), source: Buffer.from(item.source ?? '') };
    if (query?.bodyParts) {
      const map = new Map<string, Buffer>();
      for (const [k, v] of Object.entries(item.bodyParts ?? {})) map.set(k, Buffer.from(v));
      return { uid: Number(uid), bodyParts: map };
    }
    return {
      uid: Number(uid),
      size: item.size ?? Buffer.byteLength(item.source ?? ''),
      internalDate: item.internalDate ?? new Date(),
      bodyStructure: item.bodyStructure ?? null,
    };
  });

  const prisma: any = {
    mailLog: {
      findUnique: jest.fn().mockResolvedValue({
        id: MAIL_LOG_ID,
        workspaceId: WS,
        // The mail this deployment actually sent, and the only address a
        // report quoting its id is allowed to speak about.
        toAddressNorm: over.sentTo ?? 'dead@example.com',
        campaignRecipientId: RECIPIENT_ROW,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    campaignRecipient: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const suppression: any = {
    suppress: over.suppress ?? jest.fn().mockResolvedValue(undefined),
  };
  return { prisma, suppression, svc: new PlatformBouncePollService(prisma, suppression) };
}

describe('PlatformBouncePollService', () => {
  const ENV = { ...process.env };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockImap.constructed = 0;
    mockImap.connects = 0;
    mockImap.logouts = 0;
    mockImap.searchQueries = [];
    mockImap.mailbox = { uidValidity: 7n, uidNext: 200 };
    process.env.EMAIL_HOST = 'smtpout.secureserver.net';
    process.env.EMAIL_USER = PLATFORM;
    process.env.EMAIL_PASSWORD = 'pw';
    delete process.env.EMAIL_IMAP_HOST;
    delete process.env.EMAIL_IMAP_PORT;
    delete process.env.PLATFORM_BOUNCE_POLL;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  // ── inert without an operator ────────────────────────────────────────────

  it('is inert without the platform mailbox credentials, and says so once', async () => {
    delete process.env.EMAIL_PASSWORD;
    const { svc, suppression } = build({});

    const first = await svc.poll();
    const second = await svc.poll();

    expect(first.configured).toBe(false);
    expect(second.configured).toBe(false);
    expect(mockImap.constructed).toBe(0);
    expect(suppression.suppress).not.toHaveBeenCalled();
    // Named once, not every ten minutes forever.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('EMAIL_PASSWORD'))).toHaveLength(1);
  });

  it('can be stopped from the deploy settings without a code change', async () => {
    process.env.PLATFORM_BOUNCE_POLL = 'off';
    const { svc, suppression } = build({ 10: { source: dsn() } });

    const tick = await svc.poll();

    expect(tick.configured).toBe(false);
    expect(mockImap.constructed).toBe(0);
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('derives the IMAP host from EMAIL_HOST and refuses to guess an unknown one', async () => {
    const { svc } = build({ 10: { source: human() } });
    await svc.poll();
    expect(mockImap.opts.host).toBe('imap.secureserver.net');
    expect(mockImap.opts.port).toBe(993);
    expect(mockImap.opts.secure).toBe(true);

    process.env.EMAIL_HOST = 'mail.some-unknown-host.tld';
    const other = build({ 10: { source: human() } });
    const tick = await other.svc.poll();
    expect(tick.configured).toBe(false);
    expect(mockImap.constructed).toBe(1); // only the first build connected
  });

  it('negotiates STARTTLS on a plain IMAP port', async () => {
    process.env.EMAIL_IMAP_HOST = 'imap.example.com';
    process.env.EMAIL_IMAP_PORT = '143';
    const { svc } = build({ 10: { source: human() } });
    await svc.poll();
    expect(mockImap.opts.host).toBe('imap.example.com');
    expect(mockImap.opts.secure).toBe(false);
    expect(mockImap.opts.doSTARTTLS).toBe(true);
  });

  it('opens the mailbox READ-ONLY and logs out again', async () => {
    const { svc } = build({ 10: { source: dsn() } });
    await svc.poll();
    expect(mockImap.lockPath).toBe('INBOX');
    expect(mockImap.lockOptions).toEqual({ readOnly: true });
    expect(mockImap.logouts).toBe(1);
  });

  // ── what suppresses and what does not ────────────────────────────────────

  it('suppresses the 5.1.1 recipient of a DSN', async () => {
    const { svc, suppression } = build({ 10: { source: dsn({ status: '5.1.1' }) } });
    const tick = await svc.poll();

    // Scoped to the workspace the LEDGER row named — never a global write.
    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'dead@example.com',
      'EMAIL',
      'HARD_BOUNCE',
      expect.objectContaining({ source: 'dsn' }),
    );
    expect(tick.reports).toBe(1);
    expect(tick.suppressed).toBe(1);
    expect(tick.rejected).toBe(0);
  });

  it('never suppresses a 4.2.2 — a full mailbox is not a dead address', async () => {
    const { svc, suppression } = build({ 10: { source: dsn({ status: '4.2.2' }) } });
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(tick.suppressed).toBe(0);
  });

  it('never suppresses on a read receipt', async () => {
    const { svc, suppression, prisma } = build({ 10: { source: mdn() } });
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(prisma.mailLog.updateMany).not.toHaveBeenCalled();
    expect(tick.reports).toBe(0);
  });

  it('records an ARF abuse report as a complaint, never as a bounce', async () => {
    const { svc, suppression, prisma } = build(
      { 10: { source: arf() } },
      { sentTo: 'angry@example.com' },
    );
    await svc.poll();

    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'angry@example.com',
      'EMAIL',
      'COMPLAINT',
      expect.objectContaining({ source: 'dsn' }),
    );
    expect(prisma.mailLog.updateMany.mock.calls[0][0].data).toEqual({ complainedAt: expect.any(Date) });
  });

  it('suppresses only the 5.x.x rows of a mixed report', async () => {
    const { svc, suppression } = build({
      10: { source: dsn({ status: '5.1.1', second: { recipient: 'busy@example.com', status: '4.2.2' } }) },
    });
    await svc.poll();

    expect(suppression.suppress).toHaveBeenCalledTimes(1);
    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'dead@example.com',
      'EMAIL',
      'HARD_BOUNCE',
      expect.anything(),
    );
  });

  it('leaves ordinary mail in the platform mailbox alone', async () => {
    const { svc, suppression, prisma } = build({ 10: { source: human() } });
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(prisma.mailLog.findUnique).not.toHaveBeenCalled();
    expect(tick.examined).toBe(1);
    expect(tick.reports).toBe(0);
  });

  // ── a report is not a permission ─────────────────────────────────────────

  it('refuses a forged NDR that names victims in a header', async () => {
    const { svc, suppression } = build({ 10: { source: forged(['ceo@bigcustomer.com', 'finance@bigcustomer.com']) } });
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(tick.suppressed).toBe(0);
    expect(tick.rejected).toBe(1);
  });

  it('refuses a report about mail this deployment never sent', async () => {
    const { svc, suppression, prisma } = build({ 10: { source: dsn({ recipient: 'ceo@bigcustomer.com' }) } });
    prisma.mailLog.findUnique.mockResolvedValue(null);
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(tick.suppressed).toBe(0);
    expect(tick.rejected).toBe(1);
  });

  it('refuses a report that quotes a real Message-ID but names somebody else', async () => {
    // Every recipient of one of our mails holds a valid Message-ID. It is not
    // a licence to suppress a third party.
    const { svc, suppression } = build({ 10: { source: dsn({ recipient: 'ceo@bigcustomer.com' }) } });
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(tick.suppressed).toBe(0);
    expect(tick.rejected).toBe(1);
  });

  // ── attribution ──────────────────────────────────────────────────────────

  it('attributes the bounce to the MailLog row and its campaign recipient', async () => {
    const { svc, prisma } = build({ 10: { source: dsn() } });
    const tick = await svc.poll();

    expect(prisma.mailLog.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MAIL_LOG_ID } }),
    );
    const logWrite = prisma.mailLog.updateMany.mock.calls[0][0];
    expect(logWrite.where).toEqual({ id: MAIL_LOG_ID, workspaceId: WS, bouncedAt: null });
    expect(logWrite.data).toEqual({ bouncedAt: expect.any(Date) });

    const recWrite = prisma.campaignRecipient.updateMany.mock.calls[0][0];
    // Scoped by the workspace the LEDGER row named — never by anything the
    // report's sender could have chosen.
    expect(recWrite.where).toEqual({ id: RECIPIENT_ROW, workspaceId: WS, bouncedAt: null });
    expect(recWrite.data).toEqual({ bouncedAt: expect.any(Date), mailLogId: MAIL_LOG_ID });
    expect(tick.attributed).toBe(1);
  });

  it('attributes through the returned headers when Original-Message-ID is absent', async () => {
    const { svc, prisma } = build({
      10: {
        source: dsn({
          originalMessageId: null,
          returnedHeaders: [`Message-ID: <${MAIL_LOG_ID}@jeetagrowth.com>`, 'Subject: Faturanız'].join(CRLF),
        }),
      },
    });
    await svc.poll();

    expect(prisma.mailLog.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MAIL_LOG_ID } }),
    );
  });

  it('drops an unattributable report loudly instead of trusting it', async () => {
    // The stated cost of the gate: `Original-Message-ID` is optional in RFC
    // 3464, so a genuine bounce that carries neither it nor our returned
    // headers now goes unsuppressed. It must never do so silently.
    const { svc, suppression, prisma } = build({ 10: { source: dsn({ originalMessageId: null }) } });
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(prisma.mailLog.findUnique).not.toHaveBeenCalled();
    expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
    expect(tick.rejected).toBe(1);
    expect(tick.attributed).toBe(0);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('dead@example.com')),
    ).toHaveLength(1);
  });

  it('does not invent a ledger row for a foreign Message-ID', async () => {
    const { svc, suppression, prisma } = build({
      10: { source: dsn({ originalMessageId: '<CAF-not-ours-123@mail.gmail.com>' }) },
    });
    const tick = await svc.poll();

    expect(prisma.mailLog.findUnique).not.toHaveBeenCalled();
    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(tick.rejected).toBe(1);
  });

  it('writes nothing when the ledger row is gone', async () => {
    const { svc, suppression, prisma } = build({ 10: { source: dsn() } });
    prisma.mailLog.findUnique.mockResolvedValue(null);
    const tick = await svc.poll();

    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(prisma.mailLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
    expect(tick.attributed).toBe(0);
  });

  // ── never lose a bounce ──────────────────────────────────────────────────

  it('does not advance the cursor past an item it could not read', async () => {
    const { svc } = build({
      9: { source: dsn() },
      10: { throws: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) },
      11: { source: dsn({ recipient: 'later@example.com' }) },
    });

    await svc.poll();
    mockImap.searchQueries = [];
    await svc.poll();

    // Resumed AT the failed uid, not past it — and 11 was never examined first.
    expect(mockImap.searchQueries[0]).toEqual({ uid: '10:*' });
  });

  it('retries an item whose suppression write failed', async () => {
    const suppress = jest.fn().mockRejectedValue(new Error('deadlock detected'));
    const { svc } = build({ 10: { source: dsn() } }, { suppress });

    await svc.poll();
    mockImap.searchQueries = [];
    await svc.poll();

    // Nothing settled, so the lookback window is still the position — the same
    // report is read again rather than written off.
    expect(mockImap.searchQueries[0]).toHaveProperty('since');
    expect(suppress).toHaveBeenCalledTimes(2);
  });

  it('parks a poison item after three attempts instead of blocking the mailbox', async () => {
    const { svc, suppression } = build(
      {
        10: { throws: new Error('mailparser exploded') },
        11: { source: dsn({ recipient: 'behind@example.com' }) },
      },
      { sentTo: 'behind@example.com' },
    );

    await svc.poll();
    await svc.poll();
    expect(suppression.suppress).not.toHaveBeenCalled(); // uid 11 is stuck behind it

    const third = await svc.poll();

    expect(third.parked).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    // The mail queued behind the poison item gets through in the same tick.
    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'behind@example.com',
      'EMAIL',
      'HARD_BOUNCE',
      expect.anything(),
    );
    expect(third.examined).toBe(1);

    mockImap.searchQueries = [];
    await svc.poll();
    expect(mockImap.searchQueries[0]).toEqual({ uid: '12:*' });
  });

  it('caps one tick and picks the rest up on the next', async () => {
    const items: Record<number, Item> = {};
    for (let uid = 1; uid <= 60; uid++) items[uid] = { source: human() };
    const { svc } = build(items);

    const first = await svc.poll();
    expect(first.examined).toBe(50);

    const second = await svc.poll();
    expect(second.examined).toBe(10);
  });

  it('starts over when the server renumbers the mailbox', async () => {
    const { svc } = build({ 10: { source: human() }, 11: { source: human() } });
    await svc.poll();

    mockImap.mailbox = { uidValidity: 8n, uidNext: 200 };
    mockImap.searchQueries = [];
    const tick = await svc.poll();

    expect(mockImap.searchQueries[0]).toHaveProperty('since');
    expect(tick.examined).toBe(2);
  });

  // ── oversize ─────────────────────────────────────────────────────────────

  it('reads an oversize bounce through its delivery-status part', async () => {
    const report = [
      'Reporting-MTA: dns; smtpout.secureserver.net',
      `Original-Message-ID: <${MAIL_LOG_ID}@jeetagrowth.com>`,
      '',
      'Final-Recipient: rfc822; huge@example.com',
      'Action: failed',
      'Status: 5.2.1',
    ].join(CRLF);
    const headers = mime(
      {
        From: 'Mail Delivery System <MAILER-DAEMON@smtpout.secureserver.net>',
        To: PLATFORM,
        Subject: 'Undelivered Mail Returned to Sender',
        'Message-ID': '<dsn-big@secureserver.net>',
        'Content-Type': 'multipart/report; report-type=delivery-status; boundary="BIG"',
      },
      '',
    );
    const { svc, suppression, prisma } = build({
      10: {
        size: 3_000_000,
        bodyStructure: {
          type: 'multipart/report',
          parameters: { 'report-type': 'delivery-status' },
          childNodes: [
            { part: '1', type: 'text/plain' },
            { part: '2', type: 'message/delivery-status' },
          ],
        },
        bodyParts: { header: headers, '2': report },
      },
    }, { sentTo: 'huge@example.com' });

    const tick = await svc.poll();

    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'huge@example.com',
      'EMAIL',
      'HARD_BOUNCE',
      expect.anything(),
    );
    expect(prisma.mailLog.findUnique).toHaveBeenCalled();
    expect(tick.reports).toBe(1);
  });

  it('pulls the returned headers of an oversize bounce so it can still be attributed', async () => {
    // Without the id there is no authorisation, so an oversize DSN whose MTA
    // omitted Original-Message-ID would be dropped — the headers part it
    // returns is the only other place that id exists.
    const report = [
      'Reporting-MTA: dns; smtpout.secureserver.net',
      '',
      'Final-Recipient: rfc822; huge@example.com',
      'Action: failed',
      'Status: 5.2.1',
    ].join(CRLF);
    const headers = mime(
      {
        From: 'Mail Delivery System <MAILER-DAEMON@smtpout.secureserver.net>',
        To: PLATFORM,
        Subject: 'Undelivered Mail Returned to Sender',
        'Message-ID': '<dsn-big-2@secureserver.net>',
        'Content-Type': 'multipart/report; report-type=delivery-status; boundary="BIG"',
      },
      '',
    );
    const { svc, suppression, prisma } = build(
      {
        10: {
          size: 3_000_000,
          bodyStructure: {
            type: 'multipart/report',
            parameters: { 'report-type': 'delivery-status' },
            childNodes: [
              { part: '1', type: 'text/plain' },
              { part: '2', type: 'message/delivery-status' },
              { part: '3', type: 'message/rfc822-headers' },
            ],
          },
          bodyParts: {
            header: headers,
            '2': report,
            '3': [`Message-ID: <${MAIL_LOG_ID}@jeetagrowth.com>`, 'Subject: Faturanız'].join(CRLF),
          },
        },
      },
      { sentTo: 'huge@example.com' },
    );

    const tick = await svc.poll();

    expect(prisma.mailLog.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MAIL_LOG_ID } }),
    );
    expect(suppression.suppress).toHaveBeenCalledWith(
      WS,
      'huge@example.com',
      'EMAIL',
      'HARD_BOUNCE',
      expect.anything(),
    );
    expect(tick.suppressed).toBe(1);
  });

  it('skips an oversize mail that carries no report part', async () => {
    const { svc, suppression } = build({
      10: {
        size: 3_000_000,
        bodyStructure: { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain' }] },
      },
    });

    const tick = await svc.poll();
    expect(suppression.suppress).not.toHaveBeenCalled();
    expect(tick.examined).toBe(1);
  });
});
