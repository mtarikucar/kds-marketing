/**
 * The Sent-folder reconciler.
 *
 * Only the NETWORK is faked. `mailparser`, `classifyMail`, `stripQuotedReply`
 * and the address parsing are the real ones, so these tests exercise the actual
 * MIME decoding and the actual echo rules rather than a second implementation
 * written to agree with the first.
 */
const mockImap: any = {
  opts: null,
  lockPath: null,
  lockOptions: null,
  mailbox: { uidValidity: 7n, uidNext: 201 },
  folders: [
    { path: 'INBOX', specialUse: undefined },
    { path: 'Sent Items', specialUse: '\\Sent' },
  ],
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
      list: jest.fn(async () => mockImap.folders),
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

import { EmailSentPollService } from './email-sent-poll.service';

const WS = 'ws-1';
const CH_ID = 'ch-1';
const OWN = 'destek@acme.com.tr';
const CUSTOMER = 'patron@musteri.com.tr';

const SECRETS = {
  smtpHost: 'smtpout.secureserver.net',
  smtpUser: OWN,
  smtpPass: 'pw',
  fromEmail: OWN,
};

/** One message as it sits in the Sent folder. */
function rfc822(over: Record<string, string> = {}): string {
  const { __body, ...rest } = over;
  const headers: Record<string, string> = {
    From: `Acme Destek <${OWN}>`,
    To: `Ayşe Patron <${CUSTOMER}>`,
    Subject: 'Re: Teklif hakkında',
    'Message-ID': '<outlook-1@acme.com.tr>',
    'Content-Type': 'text/plain; charset=utf-8',
    ...rest,
  };
  const body = __body ?? 'Tabii, yarın gönderiyorum.\r\n\r\n> Teklifi ne zaman alabilirim?';
  return (
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') +
    '\r\n\r\n' +
    body
  );
}

/** uid → raw source, for the fetchOne mock. */
function serve(mails: Record<number, string | { source: string; size: number }>) {
  mockImap.search.mockResolvedValue(Object.keys(mails).map((u) => Number(u)));
  mockImap.fetchOne.mockImplementation(async (uidStr: string, query: any) => {
    const uid = Number(uidStr);
    const entry = mails[uid];
    if (!entry) return null;
    const source = typeof entry === 'string' ? entry : entry.source;
    const size = typeof entry === 'string' ? source.length : entry.size;
    if (query?.source) return { uid, source: Buffer.from(source) };
    if (query?.headers) {
      return { uid, headers: Buffer.from(`${source.split('\r\n\r\n')[0]}\r\n\r\n`) };
    }
    return { uid, size };
  });
}

function build(
  over: {
    secrets?: Record<string, any>;
    configPublic?: any;
    ingest?: jest.Mock;
    mailLog?: any;
    message?: any;
    campaignRecipient?: any;
    items?: any;
  } = {},
) {
  const configPublic = over.configPublic === undefined ? { readSentFolder: true } : over.configPublic;
  const channel = {
    id: CH_ID,
    workspaceId: WS,
    type: 'EMAIL',
    externalId: OWN,
    configSealed: 'sealed',
    configPublic,
  };
  const updates: any[] = [];
  const prisma: any = {
    channel: {
      findMany: jest.fn().mockResolvedValue([channel]),
      findFirst: jest.fn(async () => ({ configPublic })),
      update: jest.fn(async (args: any) => {
        updates.push(args.data.configPublic);
        return {};
      }),
    },
    mailLog: { findFirst: jest.fn().mockResolvedValue(over.mailLog ?? null) },
    message: { findFirst: jest.fn().mockResolvedValue(over.message ?? null) },
    campaignRecipient: { findFirst: jest.fn().mockResolvedValue(over.campaignRecipient ?? null) },
  };
  const registry: any = {
    has: jest.fn().mockReturnValue(true),
    resolveConfig: jest.fn((ch: any) => ({
      channelId: ch.id,
      workspaceId: ch.workspaceId,
      type: 'EMAIL',
      externalId: ch.externalId,
      secrets: over.secrets ?? SECRETS,
      public: ch.configPublic ?? {},
    })),
  };
  const ingest = over.ingest ?? jest.fn().mockResolvedValue({ deduped: false });
  const ingress: any = { ingest };
  return {
    prisma,
    registry,
    ingress,
    updates,
    items: over.items,
    svc: new EmailSentPollService(prisma, registry, ingress, over.items),
  };
}

/** A ledger that records everything and answers like package 28's service. */
function ledger() {
  return {
    open: jest.fn().mockResolvedValue({ id: 'it-1' }),
    done: jest.fn().mockResolvedValue(undefined),
    skipped: jest.fn().mockResolvedValue(undefined),
    failed: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockImap.connects = 0;
  mockImap.logouts = 0;
  mockImap.connectThrows = null;
  mockImap.lockPath = null;
  mockImap.lockOptions = null;
  mockImap.mailbox = { uidValidity: 7n, uidNext: 201 };
  mockImap.folders = [
    { path: 'INBOX', specialUse: undefined },
    { path: 'Sent Items', specialUse: '\\Sent' },
  ];
});

describe('EmailSentPollService — opt-in', () => {
  it('never opens a mailbox whose readSentFolder knob is absent (existing channels keep today behaviour)', async () => {
    const { svc, prisma } = build({ configPublic: { imapLastUid: 4 } });
    serve({ 10: rfc822() });

    const out = await svc.poll();

    expect(out).toEqual({ ingested: 0, mailboxes: 0 });
    expect(mockImap.connects).toBe(0);
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('never opens a mailbox whose readSentFolder is explicitly false', async () => {
    const { svc } = build({ configPublic: { readSentFolder: false } });
    serve({ 10: rfc822() });

    await svc.poll();

    expect(mockImap.connects).toBe(0);
  });
});

describe('EmailSentPollService — the echo', () => {
  it('ingests a reply typed in Outlook as an OUTBOUND echo keyed to the RECIPIENT', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822() });

    const out = await svc.poll();

    expect(out.ingested).toBe(1);
    expect(ingress.ingest).toHaveBeenCalledTimes(1);
    const [channel, inbound] = ingress.ingest.mock.calls[0];
    expect(channel).toEqual({ id: CH_ID, workspaceId: WS, type: 'EMAIL' });
    // The RECIPIENT, not the sender: keying an echo off From would collapse the
    // whole Sent folder into one self-thread.
    expect(inbound.externalUserId).toBe(CUSTOMER);
    expect(inbound.kind).toBe('EMAIL');
    expect(inbound.echo).toBe(true);
    expect(inbound.displayName).toBe('Ayşe Patron');
    // Brackets stripped on OUR side too, so the id matches the one the ledger
    // and an inbound-parse webhook both use.
    expect(inbound.externalMessageId).toBe('outlook-1@acme.com.tr');
    expect(inbound.text).toContain('Tabii, yarın gönderiyorum.');
    // The customer's quoted question is not part of what the owner wrote.
    expect(inbound.text).not.toContain('Teklifi ne zaman alabilirim?');
  });

  it('never pauses the AI and never touches a conversation row', async () => {
    const { svc, ingress, prisma } = build();
    serve({ 10: rfc822() });

    await svc.poll();

    // `aiPaused` on a Sent message silences the AI permanently after its own
    // first reply, because the AI's replies are in Sent too.
    expect(prisma.conversation).toBeUndefined();
    for (const [, inbound] of ingress.ingest.mock.calls) {
      expect(JSON.stringify(inbound)).not.toContain('aiPaused');
    }
    expect(JSON.stringify(prisma.channel.update.mock.calls)).not.toContain('aiPaused');
  });

  it('opens the \\Sent special-use folder READ-ONLY', async () => {
    const { svc } = build();
    serve({ 10: rfc822() });

    await svc.poll();

    expect(mockImap.lockPath).toBe('Sent Items');
    expect(mockImap.lockOptions).toEqual({ readOnly: true });
    expect(mockImap.logouts).toBe(1);
  });

  it('falls back to a well-known Sent name when the server advertises no special-use', async () => {
    mockImap.folders = [{ path: 'INBOX' }, { path: 'Gönderilmiş Öğeler' }];
    const { svc } = build();
    serve({ 10: rfc822() });

    await svc.poll();

    expect(mockImap.lockPath).toBe('Gönderilmiş Öğeler');
  });

  it('skips the mailbox entirely when no Sent folder can be identified', async () => {
    mockImap.folders = [{ path: 'INBOX' }, { path: 'Projeler' }];
    const { svc, ingress } = build();
    serve({ 10: rfc822() });

    const out = await svc.poll();

    expect(out).toEqual({ ingested: 0, mailboxes: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
  });
});

describe('EmailSentPollService — our own sends never become a second row', () => {
  it('skips a mail the outbound ledger already recorded', async () => {
    const { svc, ingress, prisma } = build({ mailLog: { id: 'ml-1' } });
    serve({ 10: rfc822() });

    const out = await svc.poll();

    expect(out.ingested).toBe(0);
    expect(ingress.ingest).not.toHaveBeenCalled();
    // Both spellings are asked for: the ledger stores ids unbracketed, older
    // rows carry nodemailer's bracketed one.
    const where = prisma.mailLog.findFirst.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(WS);
    expect(where.messageId.in).toEqual(['outlook-1@acme.com.tr', '<outlook-1@acme.com.tr>']);
  });

  it('skips a mail whose bracketed id is already on a conversation Message row', async () => {
    const { svc, ingress, prisma } = build({ message: { id: 'msg-1' } });
    serve({ 10: rfc822() });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(prisma.message.findFirst.mock.calls[0][0].where.externalMessageId.in).toEqual([
      'outlook-1@acme.com.tr',
      '<outlook-1@acme.com.tr>',
    ]);
  });

  it('skips campaign mail attributed only by CampaignRecipient.messageId', async () => {
    const { svc, ingress } = build({ campaignRecipient: { id: 'cr-1' } });
    serve({ 10: rfc822() });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('skips campaign mail by its List-Unsubscribe header alone, with no ledger hit', async () => {
    const { svc, ingress, prisma } = build();
    serve({
      10: rfc822({
        'List-Unsubscribe': '<https://jeetagrowth.com/u/tok>',
        'Message-ID': '<camp-9@acme.com.tr>',
      }),
    });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
    // A 400-recipient blast must cost 400 header reads, not 1200 queries.
    expect(prisma.mailLog.findFirst).not.toHaveBeenCalled();
  });

  it('accepts an alias on the mailbox own domain as an echo', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822({ From: `Satış <satis@acme.com.tr>` }) });

    await svc.poll();

    expect(ingress.ingest.mock.calls[0][1].externalUserId).toBe(CUSTOMER);
  });

  it('refuses to file a stranger message as ours when the folder was only guessed', async () => {
    mockImap.folders = [{ path: 'INBOX' }, { path: 'Sent' }];
    const { svc, ingress } = build();
    serve({ 10: rfc822({ From: `Ayşe <${CUSTOMER}>`, To: OWN }) });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('skips machine-written mail (Auto-Submitted) that our own AI put in Sent', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822({ 'Auto-Submitted': 'auto-replied' }) });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
  });
});

describe('EmailSentPollService — who the echo is addressed to', () => {
  it('skips a mail with more than one To recipient rather than guessing', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822({ To: `${CUSTOMER}, ikinci@musteri.com.tr` }) });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('skips a mail addressed to an unattended address', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822({ To: 'no-reply@vendor.com' }) });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('skips a mail the mailbox sent to itself', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822({ To: OWN }) });

    await svc.poll();

    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('ignores Cc and keys the echo on the single To address', async () => {
    const { svc, ingress } = build();
    serve({ 10: rfc822({ Cc: 'muhasebe@acme.com.tr' }) });

    await svc.poll();

    expect(ingress.ingest.mock.calls[0][1].externalUserId).toBe(CUSTOMER);
  });
});

describe('EmailSentPollService — oversize', () => {
  it('records the echo from headers alone rather than dropping it', async () => {
    const { svc, ingress } = build();
    serve({ 10: { source: rfc822(), size: 8_000_000 } });

    const out = await svc.poll();

    expect(out.ingested).toBe(1);
    const inbound = ingress.ingest.mock.calls[0][1];
    expect(inbound.externalUserId).toBe(CUSTOMER);
    expect(inbound.text).toContain('Re: Teklif hakkında');
    expect(inbound.text).toContain('içerik okunamadı');
  });
});

describe('EmailSentPollService — the cursor never runs past unread mail', () => {
  it('advances over a skipped item but stops dead at a throwing ingest', async () => {
    const ingest = jest.fn(async (_ch: any, m: any) => {
      if (m.externalUserId === 'ikinci@musteri.com.tr') throw new Error('db down');
      return { deduped: false };
    });
    const { svc, updates } = build({ ingest });
    serve({
      10: rfc822({ To: OWN, 'Message-ID': '<a@acme.com.tr>' }),
      11: rfc822({ To: 'ikinci@musteri.com.tr', 'Message-ID': '<b@acme.com.tr>' }),
      12: rfc822({ 'Message-ID': '<c@acme.com.tr>' }),
    });

    await svc.poll();

    // 10 was examined and deliberately skipped — that still advances. 11 threw,
    // so the cursor stops there and 12 is not even looked at.
    expect(updates.at(-1).imapSentLastUid).toBe(10);
    expect(updates.at(-1).imapSentFailUid).toBe(11);
    expect(updates.at(-1).imapSentFailCount).toBe(1);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('does not turn a first-run failure into a full-history scan on the next tick', async () => {
    const ingest = jest.fn(async () => {
      throw new Error('db down');
    });
    const { svc, updates } = build({ ingest });
    serve({
      10: rfc822({ 'Message-ID': '<a@acme.com.tr>' }),
      11: rfc822({ 'Message-ID': '<b@acme.com.tr>' }),
    });

    await svc.poll();

    // 9, not 0: resuming from 0 would ask for `uid: 1:*` — the whole folder.
    expect(updates.at(-1).imapSentLastUid).toBe(9);
    expect(updates.at(-1).imapSentFailUid).toBe(10);
  });

  it('parks a poison item after three attempts and moves the cursor past it', async () => {
    const ingest = jest.fn(async () => {
      throw new Error('always');
    });
    const { svc, updates } = build({
      ingest,
      configPublic: {
        readSentFolder: true,
        imapSentLastUid: 10,
        imapSentUidValidity: '7',
        imapSentFailUid: 11,
        imapSentFailUidValidity: '7',
        imapSentFailCount: 2,
      },
    });
    serve({ 11: rfc822({ 'Message-ID': '<b@acme.com.tr>' }) });

    await svc.poll();

    expect(updates.at(-1).imapSentLastUid).toBe(11);
    expect(updates.at(-1).imapSentFailUid).toBeNull();
    expect(updates.at(-1).imapSentFailCount).toBe(0);
  });

  it('writes its own cursor keys and preserves the rest of configPublic', async () => {
    const { svc, updates } = build({
      configPublic: { readSentFolder: true, imapLastUid: 99, imapUidValidity: '7', keepMe: true },
    });
    serve({ 10: rfc822() });

    await svc.poll();

    const written = updates.at(-1);
    expect(written.imapSentLastUid).toBe(10);
    expect(written.imapSentUidValidity).toBe('7');
    // The INBOX cursor belongs to the other poller and must survive untouched.
    expect(written.imapLastUid).toBe(99);
    expect(written.keepMe).toBe(true);
  });

  it('treats a renumbered mailbox as a first run instead of reading from a meaningless offset', async () => {
    const { svc } = build({
      configPublic: { readSentFolder: true, imapSentLastUid: 150, imapSentUidValidity: '3' },
    });
    serve({ 10: rfc822() });

    await svc.poll();

    // `since`, not `uid: 151:*` — UIDVALIDITY moved.
    expect(mockImap.search.mock.calls[0][0].since).toBeInstanceOf(Date);
  });
});

describe('EmailSentPollService — inert shapes', () => {
  it('skips a consent-connected mailbox with nothing to READ it with', async () => {
    // There is no XOAUTH2 IMAP path in this module, so a token alone buys
    // sending only — and a login attempt with credentials that cannot work is
    // a failure counted against us on the customer's mail server.
    const { svc } = build({ secrets: { oauthProvider: 'google', fromEmail: 'a@b.com' } });
    serve({ 10: rfc822() });

    await svc.poll();

    expect(mockImap.connects).toBe(0);
  });

  it('DOES read a consent mailbox that also holds an IMAP password', async () => {
    // Consent for send plus an app password for receive is two-way today,
    // with no new scope and no CASA assessment to wait for (A4.11). Refusing
    // it here would leave the same mailbox's INBOX polling while its Sent
    // folder stayed dark, for no reason a tenant could see.
    const { svc } = build({ secrets: { ...SECRETS, oauthProvider: 'google' } });
    serve({ 10: rfc822() });

    await svc.poll();

    expect(mockImap.connects).toBe(1);
  });

  it('skips a mailbox whose IMAP host cannot be resolved', async () => {
    const { svc } = build({ secrets: { ...SECRETS, smtpHost: 'mail.bilinmeyen.example' } });
    serve({ 10: rfc822() });

    await svc.poll();

    expect(mockImap.connects).toBe(0);
  });

  it('keeps one mailbox failure from stopping the sweep', async () => {
    mockImap.connectThrows = new Error('ECONNREFUSED');
    const { svc } = build();
    serve({ 10: rfc822() });

    await expect(svc.poll()).resolves.toEqual({ ingested: 0, mailboxes: 0 });
  });
});

describe('EmailSentPollService — every examined item leaves a row', () => {
  it('records an echo it filed, keyed to its OWN source', () => {
    // `imap-sent`, not `imap`: the same uid exists in both folders, and one
    // key for the two of them would collide in the ledger's unique index.
    const items = ledger();
    const { svc } = build({ items });
    serve({ 10: rfc822() });
    return svc.poll().then(() => {
      expect(items.done).toHaveBeenCalledWith(
        { workspaceId: WS, channelId: CH_ID, source: 'imap-sent', itemKey: '7:10' },
        expect.objectContaining({
          messageId: 'outlook-1@acme.com.tr',
          // The RECIPIENT: on this folder the sender is us, and "who was this
          // to" is the question anyone reading the row will have.
          fromAddress: CUSTOMER,
        }),
      );
    });
  });

  it('records WHY a campaign blast in Sent was not filed', async () => {
    // 400 recipients would otherwise be 400 conversations, and the tenant
    // asking why their campaign is not in the inbox deserves an answer.
    const items = ledger();
    const { svc, prisma } = build({ items, mailLog: { id: 'ml-1' } });
    serve({ 10: rfc822() });
    await svc.poll();
    expect(prisma.mailLog.findFirst).toHaveBeenCalled();
    expect(items.skipped).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'imap-sent', itemKey: '7:10' }),
      'own-echo',
      expect.anything(),
    );
    expect(items.done).not.toHaveBeenCalled();
  });

  it('still reconciles when the ledger write throws', async () => {
    // A bookkeeping failure must not throw in the drain loop: a throw there
    // holds the cursor and stops the folder where it stands.
    const items = ledger();
    items.open.mockRejectedValue(new Error('ledger down'));
    items.done.mockRejectedValue(new Error('ledger down'));
    const { svc, ingress } = build({ items });
    serve({ 10: rfc822() });
    await expect(svc.poll()).resolves.toEqual({ ingested: 1, mailboxes: 1 });
    expect(ingress.ingest).toHaveBeenCalled();
  });
});

describe('EmailSentPollService — the replayer contract', () => {
  it('registers itself for the imap-sent source', () => {
    const items = { ...ledger(), registerReplayer: jest.fn() };
    const { svc } = build({ items });
    svc.onModuleInit();
    expect(items.registerReplayer).toHaveBeenCalledWith('imap-sent', expect.any(Function));
  });

  it('replays exactly the one uid the ledger row names, and settles it', async () => {
    const items = { ...ledger(), registerReplayer: jest.fn() };
    const { svc, prisma } = build({ items });
    prisma.channel.findFirst.mockResolvedValue({
      id: CH_ID,
      workspaceId: WS,
      type: 'EMAIL',
      externalId: OWN,
      configSealed: 'sealed',
      configPublic: { readSentFolder: true },
    });
    serve({ 10: rfc822() });

    await svc.replay({ id: 'it-1', workspaceId: WS, channelId: CH_ID, source: 'imap-sent', itemKey: '7:10' });

    expect(items.done).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '7:10', source: 'imap-sent' }),
      expect.anything(),
    );
  });

  it('THROWS rather than replaying the wrong mail after a renumbering', async () => {
    // The runner's backoff IS the retry schedule, and a replayer that
    // swallows its error reports success for an echo that was never filed.
    // After a UIDVALIDITY change that uid names somebody else's mail.
    const items = { ...ledger(), registerReplayer: jest.fn() };
    const { svc, prisma } = build({ items });
    prisma.channel.findFirst.mockResolvedValue({
      id: CH_ID,
      workspaceId: WS,
      type: 'EMAIL',
      externalId: OWN,
      configSealed: 'sealed',
      configPublic: { readSentFolder: true },
    });
    serve({ 10: rfc822() });

    await expect(
      svc.replay({ id: 'it-1', workspaceId: WS, channelId: CH_ID, source: 'imap-sent', itemKey: '999:10' }),
    ).rejects.toThrow(/renumbered/);
    expect(items.done).not.toHaveBeenCalled();
  });

  it('scopes the channel read to the row workspace', async () => {
    const items = { ...ledger(), registerReplayer: jest.fn() };
    const { svc, prisma } = build({ items });
    prisma.channel.findFirst.mockResolvedValue(null);
    await expect(
      svc.replay({ id: 'it-1', workspaceId: WS, channelId: CH_ID, source: 'imap-sent', itemKey: '7:10' }),
    ).rejects.toThrow(/no longer pollable/);
    expect(prisma.channel.findFirst.mock.calls.at(-1)[0].where).toMatchObject({
      id: CH_ID,
      workspaceId: WS,
    });
  });
});
