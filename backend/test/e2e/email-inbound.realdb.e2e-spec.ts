/**
 * The INBOUND half of email, end to end, against REAL Postgres.
 *
 * The outbound money journey lives in `email-journey.realdb.e2e-spec.ts` and
 * this is deliberately NOT a step of it: that spec's `afterAll` clears invoice,
 * estimate, lead and workspace rows and nothing else, so an inbound step bolted
 * on there would leak a channel, a contactIdentity, a conversation and a
 * message on every run. This file owns — and cleans — all of those.
 *
 * ## What only a real database can prove
 *
 * Every assertion below depends on a column, an index or a unique constraint
 * rather than on a service agreeing with its own mock:
 *
 *  - **Adoption.** `findLeadByContact` matches on `Lead.emailNormalized`. A
 *    mocked Prisma answers whatever the spec told it to; only Postgres can show
 *    that a customer entered by hand and then writing in stays ONE lead.
 *  - **Idempotency, including the race.** The fast-path dedup is a query; the
 *    backstop is `@@unique([workspaceId, externalMessageId])`. The P2002 branch
 *    is unreachable without a live constraint to violate.
 *  - **Cross-tenant isolation.** That unique is workspace-scoped. Two tenants
 *    receiving a mail with the SAME `Message-ID` must each get their own
 *    message — the single most expensive thing to get wrong here.
 *  - **The DSN lane.** A bounce suppresses through `SuppressionService`, which
 *    writes a hashed `ContactSuppression` row AND projects onto every lead that
 *    shares the address. Both halves are SQL.
 *  - **Nothing is lost on a failure.** A mid-batch IMAP error must leave the
 *    cursor where it was and a FAILED ledger row behind; a webhook 5xx must
 *    leave a FAILED row that a redelivery flips to DONE without duplicating the
 *    message.
 *
 * ## Only the network is faked
 *
 * `imapflow` is mocked at module scope — everything else is the container's
 * real object graph: `mailparser`, `classifyMail`, `EmailChannelAdapter`,
 * `ConversationIngressService`, `SuppressionService`, the ledger, the outbox.
 * The channel's credentials are sealed with the real `sealSecret`, because
 * `ChannelAdapterRegistry.resolveConfig` opens an AES-256-GCM box: without
 * `MARKETING_SECRET_KEY` set BEFORE boot the poller silently skips the channel
 * and every test here would pass vacuously. The assertions are written against
 * persisted ROWS for exactly that reason — never against "it did not throw".
 *
 * Opt-in via E2E_REAL_DB=1, like every other real-DB lane.
 */
import { randomBytes, randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';

/** The fake mail server the mocked ImapFlow serves from. */
const imapServer = {
  uidValidity: 42n,
  uidNext: 200,
  uids: [] as number[],
  sources: new Map<number, string>(),
  /** uids whose FULL-SOURCE fetch blows up — a socket dropped mid-batch. */
  breakOnSource: new Set<number>(),
  connects: 0,
  reset(): void {
    imapServer.uids = [];
    imapServer.sources.clear();
    imapServer.breakOnSource.clear();
  },
  serve(uid: number, source: string): void {
    imapServer.uids.push(uid);
    imapServer.sources.set(uid, source);
  },
};

jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect: jest.fn(async () => {
      imapServer.connects++;
    }),
    logout: jest.fn(async () => undefined),
    getMailboxLock: jest.fn(async () => ({ release: jest.fn() })),
    get mailbox() {
      return { uidValidity: imapServer.uidValidity, uidNext: imapServer.uidNext };
    },
    search: jest.fn(async () => [...imapServer.uids]),
    fetchOne: jest.fn(async (rawUid: string, query: any) => {
      const uid = Number(rawUid);
      const source = imapServer.sources.get(uid);
      if (!source) return null;
      const head = { size: source.length, internalDate: new Date() };
      if (query?.source) {
        if (imapServer.breakOnSource.has(uid)) {
          throw new Error('ECONNRESET while downloading the message source');
        }
        return { ...head, source: Buffer.from(source, 'utf8') };
      }
      if (query?.headers) {
        const end = source.indexOf('\r\n\r\n');
        return {
          ...head,
          headers: Buffer.from(end < 0 ? source : source.slice(0, end + 4), 'utf8'),
          bodyStructure: null,
        };
      }
      return head;
    }),
  })),
}));

import { PrismaService } from '../../src/prisma/prisma.service';
import { sealSecret } from '../../src/common/crypto/secret-box.helper';
import { ChannelAdapterRegistry } from '../../src/modules/marketing/channels/channel-adapter.registry';
import { ConversationIngressService } from '../../src/modules/marketing/channels/conversation-ingress.service';
import { EmailImapPollService } from '../../src/modules/marketing/channels/email-imap-poll.service';
import { MailboxHealthService, isMailboxBackedOff, readMailboxHealth } from '../../src/modules/marketing/channels/mailbox-health.service';
import { emailInboundToken } from '../../src/modules/marketing/channels/email-inbound-callback.util';
import { SuppressionService } from '../../src/modules/marketing/compliance/suppression.service';
import { MarketingEventTypes } from '../../src/modules/marketing/events/marketing-event-types';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

const SEED = `e2e-${randomUUID().slice(0, 8)}`;
const PLATFORM_FROM = `no-reply-${SEED}@jeeta.test`;
const OWN_A = `destek-${SEED}@acme.test`;
const OWN_B = `destek-${SEED}@beta.test`;
const UID_VALIDITY = '42';

const describeRealDb = realDbEnabled() ? describe : describe.skip;

/** An RFC822 message, in the shape a mail server actually hands one over. */
function rfc822(over: Record<string, string> & { __body?: string }): string {
  const { __body, ...headers } = over;
  const all: Record<string, string> = {
    To: OWN_A,
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  };
  return (
    Object.entries(all)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') +
    '\r\n\r\n' +
    (__body ?? 'Merhaba, fiyat listesini alabilir miyim?')
  );
}

/** A real RFC 3464 report — one field block per recipient, as the RFC says. */
function dsn(recipient: string, status: string): string {
  const body = [
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is the mail system at host mail.acme.test.',
    '',
    '--b',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mail.acme.test',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    'Action: failed',
    `Status: ${status}`,
    'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    '--b--',
  ].join('\r\n');
  return rfc822({
    From: 'Mail Delivery System <MAILER-DAEMON@acme.test>',
    Subject: 'Undelivered Mail Returned to Sender',
    'Message-ID': `<dsn-${SEED}-${status}@acme.test>`,
    'Content-Type': 'multipart/report; report-type=delivery-status; boundary="b"',
    __body: body,
  });
}

describeRealDb('Email inbound journey — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let registry: ChannelAdapterRegistry;
  let ingress: ConversationIngressService;
  let poller: EmailImapPollService;
  let suppression: SuppressionService;
  let health: MailboxHealthService;

  const wsA = randomUUID();
  const wsB = randomUUID();
  const chA = randomUUID();
  const chB = randomUUID();
  const ownerA = randomUUID();
  const sentinelA = randomUUID();

  const secretsFor = (own: string) => ({
    smtpHost: 'smtp.acme.test',
    smtpUser: own,
    smtpPass: 'not-a-real-password',
    fromEmail: own,
    // Typed by the workspace, so `imapTarget` resolves without leaning on the
    // SMTP-host autodiscover table.
    imapHost: 'imap.acme.test',
    imapPort: '993',
  });

  /** The channel row the poller and the adapter both read. */
  const channelRow = async (id: string) =>
    prisma.channel.findUniqueOrThrow({ where: { id } });

  /** The real normalizer: an adapter-built InboundMessage for this channel. */
  const normalize = async (
    channelId: string,
    body: Record<string, unknown>,
  ) => {
    const row = await channelRow(channelId);
    const config = registry.resolveConfig(row as any);
    const adapter = registry.get('EMAIL');
    return adapter.parseInbound!(config, body);
  };

  const ingestOne = async (
    channelId: string,
    workspaceId: string,
    body: Record<string, unknown>,
  ) => {
    const [message] = await normalize(channelId, body);
    expect(message).toBeDefined();
    return ingress.ingest({ id: channelId, workspaceId, type: 'EMAIL' }, message);
  };

  /** Put the cursor back so the next poll reads from `lastUid + 1`. */
  const setCursor = async (channelId: string, lastUid: number) => {
    const row = await channelRow(channelId);
    const pub = (row.configPublic as Record<string, unknown> | null) ?? {};
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        configPublic: {
          ...pub,
          imapLastUid: lastUid,
          imapUidValidity: UID_VALIDITY,
          imapFailUid: null,
          imapFailUidValidity: null,
          imapFailCount: null,
        },
      },
    });
  };

  const cursorOf = async (channelId: string) => {
    const row = await channelRow(channelId);
    return (row.configPublic as Record<string, any>) ?? {};
  };

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    // BEFORE boot: `resolveConfig` opens an AES-256-GCM box with this key, and
    // the tokenized inbound URL is an HMAC under the same master key. Without
    // it the poller skips the channel and the webhook 401s — silently, which is
    // exactly the vacuous pass this lane exists to prevent.
    process.env.MARKETING_SECRET_KEY = randomBytes(32).toString('base64');
    // `classifyMail` drops this platform's own address; keep it clear of every
    // sender below so no fixture is skipped as our own mail.
    process.env.EMAIL_FROM = PLATFORM_FROM;
    process.env.PUBLIC_BASE_URL = 'https://inbound.test';

    ({ app, prisma } = await createRealDbTestApp());
    registry = app.get(ChannelAdapterRegistry);
    ingress = app.get(ConversationIngressService);
    poller = app.get(EmailImapPollService);
    suppression = app.get(SuppressionService);
    health = app.get(MailboxHealthService);

    // Silence every cron. The five-minute IMAP sweep and the scheduled-job
    // runner would both fire against the mocked mail server mid-assertion, and
    // the sweep is platform-wide where every call below is channel-scoped.
    const scheduler = app.get(SchedulerRegistry);
    for (const [, cron] of scheduler.getCronJobs()) {
      try {
        (cron as { stop?: () => void }).stop?.();
      } catch {
        /* a cron that will not stop is not this spec's problem to fix */
      }
    }

    await prisma.workspace.createMany({
      data: [
        { id: wsA, slug: `${SEED}-a`, name: 'Acme Inbound', productName: 'Acme POS' },
        { id: wsB, slug: `${SEED}-b`, name: 'Beta Inbound', productName: 'Beta POS' },
      ],
    });
    await prisma.marketingUser.createMany({
      data: [
        {
          id: ownerA,
          workspaceId: wsA,
          email: `owner-${SEED}@acme.test`,
          password: 'seed-not-a-real-hash',
          firstName: 'Olive',
          lastName: 'Owner',
          role: 'OWNER',
          status: 'ACTIVE',
        },
        {
          // The SYSTEM sentinel owns the "new conversation" lead-activity note.
          id: sentinelA,
          workspaceId: wsA,
          email: `system-${SEED}@acme.test`,
          password: 'seed-not-a-real-hash',
          firstName: 'System',
          lastName: 'Sentinel',
          role: 'SYSTEM',
          status: 'ACTIVE',
        },
      ],
    });
    await prisma.workspaceMembership.create({
      data: { userId: ownerA, workspaceId: wsA, role: 'OWNER', status: 'ACTIVE' },
    });

    await prisma.channel.createMany({
      data: [
        {
          id: chA,
          workspaceId: wsA,
          type: 'EMAIL',
          name: 'Acme mailbox',
          status: 'ACTIVE',
          externalId: OWN_A,
          configSealed: sealSecret(JSON.stringify(secretsFor(OWN_A))),
          // A cursor, so the poller RESUMES rather than treating every tick as
          // a first run — a first run holds the automation back
          // (`suppressAutomation`) and there would be no AI cue to assert.
          configPublic: { imapLastUid: 90, imapUidValidity: UID_VALIDITY },
          lastVerifiedAt: new Date(),
        },
        {
          id: chB,
          workspaceId: wsB,
          type: 'EMAIL',
          name: 'Beta mailbox',
          status: 'ACTIVE',
          externalId: OWN_B,
          configSealed: sealSecret(JSON.stringify(secretsFor(OWN_B))),
          configPublic: { imapLastUid: 90, imapUidValidity: UID_VALIDITY },
          lastVerifiedAt: new Date(),
        },
      ],
    });
  });

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    for (const workspaceId of [wsA, wsB]) {
      // Children first: message → conversation → contactIdentity → channel, then
      // everything the ingest hung off the lead.
      await del(() => prisma.message.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.conversation.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.contactIdentity.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.emailInboundItem.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.scheduledJob.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingNotification.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.contactSuppression.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.consentRecord.deleteMany({ where: { workspaceId } }));
      await del(() =>
        prisma.leadActivity.deleteMany({ where: { lead: { workspaceId } } }),
      );
      await del(() => prisma.lead.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.channel.deleteMany({ where: { workspaceId } }));
      // By PAYLOAD, not `tenantId`: the marketing producers leave `tenantId`
      // null, so a tenant-scoped delete would quietly leak every event this
      // lane emitted.
      await del(() =>
        prisma.outboxEvent.deleteMany({
          where: { payload: { path: ['workspaceId'], equals: workspaceId } },
        }),
      );
      await del(() => prisma.workspaceMembership.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workspace.delete({ where: { id: workspaceId } }));
    }
    await closeTestApp(app);
  });

  beforeEach(() => {
    imapServer.reset();
  });

  // ────────────────────────────────────────────────────────────────────────
  // The live path: a mail server, the poller, and the rows it leaves behind.
  // ────────────────────────────────────────────────────────────────────────
  describe('the poller — a reply becomes a conversation, a lead and an AI cue', () => {
    const sender = `musteri-${SEED}@example.com`;
    const messageId = `reply-${SEED}@mail.example.com`;

    it('carries one mail from the mailbox to a message, a lead and the outbox', async () => {
      imapServer.serve(
        91,
        rfc822({
          From: `Deniz Yılmaz <${sender}>`,
          Subject: 'Re: Teklif',
          'Message-ID': `<${messageId}>`,
          __body: 'Evet, ilgileniyorum.\r\n\r\n> Bu mesaj panelden gönderildi.',
        }),
      );

      const ingested = await poller.pollOne(wsA, chA);
      expect(ingested).toBe(1);

      const message = await prisma.message.findFirst({
        where: { workspaceId: wsA, externalMessageId: messageId },
      });
      expect(message).toBeTruthy();
      expect(message!.direction).toBe('INBOUND');
      expect(message!.authorType).toBe('CUSTOMER');
      // Subject first, then the customer's own words with the quote stripped.
      expect(message!.body).toContain('Re: Teklif');
      expect(message!.body).toContain('Evet, ilgileniyorum.');
      expect(message!.body).not.toContain('panelden gönderildi');

      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: message!.conversationId },
      });
      expect(conversation.workspaceId).toBe(wsA);
      expect(conversation.channelId).toBe(chA);
      expect(conversation.status).toBe('OPEN');
      expect(conversation.unreadCount).toBe(1);
      expect(conversation.lastInboundAt).toBeTruthy();

      const identity = await prisma.contactIdentity.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, value: sender },
      });
      expect(identity.kind).toBe('EMAIL');
      expect(identity.leadId).toBe(conversation.leadId);

      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: identity.leadId } });
      expect(lead.emailNormalized).toBe(sender);
      expect(lead.source).toBe('EMAIL');
      // The display name, not the address — "Channel contact" is not a name.
      expect(lead.businessName).toBe('Deniz Yılmaz');

      // The AI cue. This is the event the reply engine and the message-triggered
      // workflows hang off; without it the mail lands and nothing answers.
      const cue = await prisma.outboxEvent.findFirst({
        // Keyed on the message, not on `tenantId`: marketing events carry the
        // workspace in the PAYLOAD and leave `tenantId` null, which is safe
        // only because every key here is already globally unique (a message id).
        where: {
          type: MarketingEventTypes.ConversationMessageReceived,
          idempotencyKey: `conv-msg:${message!.id}`,
        },
      });
      expect(cue).toBeTruthy();
      expect((cue!.payload as any).workspaceId).toBe(wsA);
      expect((cue!.payload as any).conversationId).toBe(conversation.id);
      expect((cue!.payload as any).leadId).toBe(identity.leadId);

      // "Where did my customer's mail go?" — answered by a row, not a log line.
      const item = await prisma.emailInboundItem.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, source: 'imap', itemKey: `${UID_VALIDITY}:91` },
      });
      expect(item.state).toBe('DONE');
      expect(item.fromAddress).toBe(sender);
      expect(item.messageId).toBe(messageId);

      // The cursor moved exactly one uid.
      expect((await cursorOf(chA)).imapLastUid).toBe(91);
    });

    it('re-reading the same uid produces no second message', async () => {
      // A restarted process, a reset cursor, a double tick — all the same thing.
      await setCursor(chA, 90);
      imapServer.serve(
        91,
        rfc822({
          From: `Deniz Yılmaz <${sender}>`,
          Subject: 'Re: Teklif',
          'Message-ID': `<${messageId}>`,
          __body: 'Evet, ilgileniyorum.',
        }),
      );

      await poller.pollOne(wsA, chA);

      expect(
        await prisma.message.count({ where: { workspaceId: wsA, externalMessageId: messageId } }),
      ).toBe(1);
      expect(
        await prisma.conversation.count({ where: { workspaceId: wsA, channelId: chA } }),
      ).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Identity and dedup, through the real normalizer.
  // ────────────────────────────────────────────────────────────────────────
  describe('identity — who this mail is from, and who they already are', () => {
    it('adopts the lead that already carries the address instead of making a second', async () => {
      const address = `elif-${SEED}@musteri.test`;
      const seeded = await prisma.lead.create({
        data: {
          workspaceId: wsA,
          businessName: 'Elif Pastanesi',
          contactPerson: 'Elif',
          businessType: 'CAFE',
          source: 'MANUAL',
          status: 'NEW',
          // Entered by hand months ago; no identity on the email channel at all.
          email: address.toUpperCase(),
          emailNormalized: address,
        },
      });

      const result = await ingestOne(chA, wsA, {
        from: `Elif <${address}>`,
        subject: 'Siparişim hakkında',
        text: 'Geçen haftaki siparişimi sormak istiyorum.',
        messageId: `adopt-${SEED}@musteri.test`,
      });

      expect(result!.leadId).toBe(seeded.id);
      expect(
        await prisma.lead.count({ where: { workspaceId: wsA, emailNormalized: address } }),
      ).toBe(1);
      const identity = await prisma.contactIdentity.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, value: address },
      });
      expect(identity.leadId).toBe(seeded.id);
    });

    it('routes on the envelope address, never on a display name that looks like one', async () => {
      // The forged half: a real lead the attacker would like to be taken for.
      const impersonated = `ceo-${SEED}@acme-bank.test`;
      const victim = await prisma.lead.create({
        data: {
          workspaceId: wsA,
          businessName: 'Acme Bank',
          contactPerson: 'Genel Müdür',
          businessType: 'OTHER',
          source: 'MANUAL',
          status: 'NEW',
          email: impersonated,
          emailNormalized: impersonated,
        },
      });
      const attacker = `saldirgan-${SEED}@evil.test`;

      const result = await ingestOne(chA, wsA, {
        from: `"${impersonated}" <${attacker}>`,
        subject: 'Acil ödeme talimatı',
        text: 'Lütfen bu hesaba havale yapın.',
        messageId: `forged-${SEED}@evil.test`,
      });

      expect(result!.leadId).not.toBe(victim.id);
      const identity = await prisma.contactIdentity.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, leadId: result!.leadId },
      });
      expect(identity.value).toBe(attacker);
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: result!.leadId } });
      expect(lead.emailNormalized).toBe(attacker);
      // The impersonated record was not touched, and no identity was minted
      // under the forged spelling.
      expect(
        await prisma.contactIdentity.count({ where: { workspaceId: wsA, value: impersonated } }),
      ).toBe(0);
      expect(
        await prisma.conversation.count({ where: { workspaceId: wsA, leadId: victim.id } }),
      ).toBe(0);
    });
  });

  describe('dedup — the same message, twice, and the race between the two', () => {
    const address = `tekrar-${SEED}@musteri.test`;
    const externalMessageId = `dup-${SEED}@musteri.test`;
    const body = {
      from: `Tekrar <${address}>`,
      subject: 'Aynı mesaj',
      text: 'Bir kere yazdım.',
      messageId: externalMessageId,
    };

    it('resolves a redelivery to the message it already has', async () => {
      const first = await ingestOne(chA, wsA, body);
      expect(first!.deduped).toBe(false);

      const second = await ingestOne(chA, wsA, body);
      expect(second!.deduped).toBe(true);
      expect(second!.messageId).toBe(first!.messageId);
      expect(
        await prisma.message.count({ where: { workspaceId: wsA, externalMessageId } }),
      ).toBe(1);
    });

    it('survives the concurrent delivery the unique index exists to catch', async () => {
      const before = await prisma.message.findFirstOrThrow({
        where: { workspaceId: wsA, externalMessageId },
      });
      const conversations = await prisma.conversation.count({ where: { workspaceId: wsA } });

      // The race, exactly: the fast-path read happens BEFORE the concurrent
      // insert commits, so it sees nothing and the transaction walks into the
      // `@@unique([workspaceId, externalMessageId])` violation. Only the first
      // read is blinded — the P2002 handler's own re-resolve must find the row.
      const spy = jest
        .spyOn(prisma.message, 'findFirst')
        // Cast because a Prisma delegate promises a `PrismaPromise`; a plain one
        // is all the caller here awaits.
        .mockImplementationOnce((() => Promise.resolve(null)) as any);
      try {
        const raced = await ingestOne(chA, wsA, body);
        expect(raced!.deduped).toBe(true);
        expect(raced!.messageId).toBe(before.id);
      } finally {
        spy.mockRestore();
      }

      expect(
        await prisma.message.count({ where: { workspaceId: wsA, externalMessageId } }),
      ).toBe(1);
      // The rolled-back transaction left nothing behind.
      expect(await prisma.conversation.count({ where: { workspaceId: wsA } })).toBe(conversations);
    });

    it('gives a second tenant its own copy of a mail carrying the same Message-ID', async () => {
      // A newsletter, a forwarded thread, a provider that reuses ids: the same
      // `Message-ID` genuinely does arrive at two tenants. Dropping the second
      // as a duplicate would hand one tenant's customer silence.
      const shared = `shared-${SEED}@example.com`;
      const sharedId = `crosstenant-${SEED}@example.com`;
      const payload = {
        from: `Ortak Gönderen <${shared}>`,
        subject: 'Her ikinize de',
        text: 'İki ayrı şirkete yazıyorum.',
        messageId: sharedId,
      };

      const a = await ingestOne(chA, wsA, payload);
      const b = await ingestOne(chB, wsB, payload);

      expect(b!.deduped).toBe(false);
      expect(b!.messageId).not.toBe(a!.messageId);
      expect(await prisma.message.count({ where: { externalMessageId: sharedId } })).toBe(2);

      const inB = await prisma.message.findFirstOrThrow({
        where: { workspaceId: wsB, externalMessageId: sharedId },
      });
      const convoB = await prisma.conversation.findUniqueOrThrow({
        where: { id: inB.conversationId },
      });
      expect(convoB.workspaceId).toBe(wsB);
      expect(convoB.channelId).toBe(chB);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // A bounce is not a lead.
  // ────────────────────────────────────────────────────────────────────────
  describe('the DSN lane — a bounce stops the next send', () => {
    it('suppresses the address a 5.x.x report names and projects it onto the lead', async () => {
      const dead = `yok-${SEED}@musteri.test`;
      const lead = await prisma.lead.create({
        data: {
          workspaceId: wsA,
          businessName: 'Kapanmış Dükkan',
          contactPerson: 'Yok',
          businessType: 'OTHER',
          source: 'MANUAL',
          status: 'NEW',
          email: dead,
          emailNormalized: dead,
        },
      });

      await setCursor(chA, 100);
      imapServer.serve(101, dsn(dead, '5.1.1'));
      await poller.pollOne(wsA, chA);

      // The row the outbound gate reads for an address with no lead at all.
      const rows = await prisma.contactSuppression.findMany({
        where: { workspaceId: wsA, kind: 'EMAIL', reason: 'HARD_BOUNCE' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('dsn');
      expect(await suppression.check(wsA, dead, 'BULK')).toEqual({
        suppressed: true,
        reason: 'HARD_BOUNCE',
      });

      // …and the projection onto every lead that shares the address.
      const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.emailBouncedAt).toBeTruthy();

      // A bounce is not a lead: no conversation, no message, no AI cue — and a
      // ledger row that SAYS so.
      expect(
        await prisma.contactIdentity.count({ where: { workspaceId: wsA, value: dead } }),
      ).toBe(0);
      const item = await prisma.emailInboundItem.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, itemKey: `${UID_VALIDITY}:101` },
      });
      expect(item.state).toBe('SKIPPED');
      expect(item.reason).toBe('dsn');
    });

    it('suppresses nobody on a 4.x.x — that is a full mailbox, not a dead address', async () => {
      const busy = `dolu-${SEED}@musteri.test`;
      await setCursor(chA, 101);
      imapServer.serve(102, dsn(busy, '4.2.2'));
      await poller.pollOne(wsA, chA);

      expect(
        await prisma.contactSuppression.count({
          where: { workspaceId: wsA, kind: 'EMAIL', reason: 'HARD_BOUNCE' },
        }),
      ).toBe(1); // the 5.1.1 above, and only it
      expect(await suppression.check(wsA, busy, 'BULK')).toEqual({ suppressed: false });
      // Still advanced: a bounce must not pin the customer mail behind it.
      expect((await cursorOf(chA)).imapLastUid).toBe(102);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Failure paths — nothing is lost, and a human can see where it stopped.
  // ────────────────────────────────────────────────────────────────────────
  describe('a mid-batch IMAP failure', () => {
    it('leaves the cursor put and files the uid that failed', async () => {
      const sender = `yarim-${SEED}@musteri.test`;
      await setCursor(chA, 110);
      imapServer.serve(111, rfc822({
        From: `Yarım <${sender}>`,
        Subject: 'Yarıda kalan',
        'Message-ID': `<broken-${SEED}@musteri.test>`,
      }));
      imapServer.serve(112, rfc822({
        From: `Sonraki <sonraki-${SEED}@musteri.test>`,
        Subject: 'Arkadaki',
        'Message-ID': `<behind-${SEED}@musteri.test>`,
      }));
      imapServer.breakOnSource.add(111);

      await poller.pollOne(wsA, chA);

      // The cursor did NOT move past the mail we could not read. That single
      // ordering is the difference between "a socket drop costs one re-read"
      // and "a socket drop permanently skips a customer's reply".
      const cursor = await cursorOf(chA);
      expect(cursor.imapLastUid).toBe(110);
      expect(cursor.imapFailUid).toBe(111);
      expect(cursor.imapFailCount).toBe(1);

      // Neither mail was ingested, and neither is lost — both are behind a
      // cursor that will re-read them.
      expect(
        await prisma.message.count({
          where: { workspaceId: wsA, externalMessageId: `broken-${SEED}@musteri.test` },
        }),
      ).toBe(0);
      expect(
        await prisma.message.count({
          where: { workspaceId: wsA, externalMessageId: `behind-${SEED}@musteri.test` },
        }),
      ).toBe(0);

      const item = await prisma.emailInboundItem.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, itemKey: `${UID_VALIDITY}:111` },
      });
      expect(item.state).toBe('FAILED');
      expect(item.attempts).toBe(1);
      expect(item.lastError).toContain('ECONNRESET');
      // A failure buys exactly one queued retry, collapsed on the item id.
      expect(
        await prisma.scheduledJob.count({
          where: { workspaceId: wsA, kind: 'mail.inbound.retry', dedupKey: `inbound:${item.id}` },
        }),
      ).toBe(1);
    });

    it('picks both mails up on the next tick, once the fetch works again', async () => {
      imapServer.serve(111, rfc822({
        From: `Yarım <yarim-${SEED}@musteri.test>`,
        Subject: 'Yarıda kalan',
        'Message-ID': `<broken-${SEED}@musteri.test>`,
      }));
      imapServer.serve(112, rfc822({
        From: `Sonraki <sonraki-${SEED}@musteri.test>`,
        Subject: 'Arkadaki',
        'Message-ID': `<behind-${SEED}@musteri.test>`,
      }));

      const ingested = await poller.pollOne(wsA, chA);

      expect(ingested).toBe(2);
      expect((await cursorOf(chA)).imapLastUid).toBe(112);
      expect((await cursorOf(chA)).imapFailUid).toBeNull();
      const item = await prisma.emailInboundItem.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, itemKey: `${UID_VALIDITY}:111` },
      });
      expect(item.state).toBe('DONE');
    });
  });

  describe('the tokenized webhook', () => {
    const address = `relay-${SEED}@musteri.test`;
    const externalMessageId = `relayed-${SEED}@musteri.test`;
    const post = () =>
      request(app.getHttpServer())
        .post(`/api/public/channels/email/${chA}/${emailInboundToken(chA)}/inbound`)
        .set('content-type', 'application/json')
        .send({
          from: `Relay Müşterisi <${address}>`,
          subject: 'Röle üzerinden',
          text: 'Bir ara siteden yazmıştım.',
          'message-id': `<${externalMessageId}>`,
          recipient: OWN_A,
        });

    it('answers 5xx and files the failure when the ingest breaks', async () => {
      const spy = jest
        .spyOn(ingress, 'ingest')
        .mockImplementationOnce(async () => {
          throw new Error('the database went away mid-ingest');
        });
      try {
        await post().expect(503);
      } finally {
        spy.mockRestore();
      }

      expect(
        await prisma.message.count({ where: { workspaceId: wsA, externalMessageId } }),
      ).toBe(0);
      // Without this row the `open()` above would leave a NEW item nobody ever
      // settles — invisible in exactly the way the ledger exists to stop.
      const item = await prisma.emailInboundItem.findFirstOrThrow({
        where: { workspaceId: wsA, channelId: chA, source: 'webhook', itemKey: externalMessageId },
      });
      expect(item.state).toBe('FAILED');
      expect(item.attempts).toBe(1);
      expect(item.fromAddress).toBe(address);
    });

    it('takes the relay redelivery and lands the mail exactly once', async () => {
      const res = await post().expect(201);
      expect(res.body).toEqual({ ok: true, received: 1 });

      expect(
        await prisma.message.count({ where: { workspaceId: wsA, externalMessageId } }),
      ).toBe(1);
      // Same ledger row — re-keyed, not duplicated — now settled.
      const items = await prisma.emailInboundItem.findMany({
        where: { workspaceId: wsA, channelId: chA, source: 'webhook', itemKey: externalMessageId },
      });
      expect(items).toHaveLength(1);
      expect(items[0].state).toBe('DONE');

      // And a second redelivery of the same bytes is still one message.
      await post().expect(201);
      expect(
        await prisma.message.count({ where: { workspaceId: wsA, externalMessageId } }),
      ).toBe(1);
    });

    it('refuses a forged token without touching the database', async () => {
      await request(app.getHttpServer())
        .post(`/api/public/channels/email/${chA}/${'0'.repeat(64)}/inbound`)
        .set('content-type', 'application/json')
        .send({ from: `forged-${SEED}@evil.test`, text: 'let me in' })
        .expect(401);
      expect(
        await prisma.contactIdentity.count({
          where: { workspaceId: wsA, value: `forged-${SEED}@evil.test` },
        }),
      ).toBe(0);
    });
  });

  describe('mailbox backoff — a mailbox that keeps failing waits longer', () => {
    it('climbs the ladder in the channel row and a good poll clears it', async () => {
      const ref = { id: chB, workspaceId: wsB };
      // A neighbouring setting, to prove the health write is a MERGE and not a
      // clobber: `configPublic` is shared with the cursor and the tenant's own
      // settings, and a blind overwrite here would unplug the mailbox.
      await prisma.channel.update({
        where: { id: chB },
        data: { configPublic: { imapLastUid: 90, imapUidValidity: UID_VALIDITY, fromName: 'Beta Destek' } },
      });

      const first = await health.recordBackoff(ref, { error: 'ECONNREFUSED', reason: 'CONNECT_FAILED' });
      expect(first.failCount).toBe(1);
      const second = await health.recordBackoff(ref, { error: 'ECONNREFUSED', reason: 'CONNECT_FAILED' });
      expect(second.failCount).toBe(2);
      // 1 minute, then 2 — the ladder, not a flat retry.
      expect(second.backoffUntil.getTime() - first.backoffUntil.getTime()).toBeGreaterThan(30_000);

      const row = await channelRow(chB);
      const stored = readMailboxHealth(row.configPublic);
      expect(stored.consecutiveFailures).toBe(2);
      expect(isMailboxBackedOff(row.configPublic)).toBe(true);
      expect(stored.receive?.ok).toBe(false);
      expect(stored.receive?.reason).toBe('CONNECT_FAILED');
      // The merge kept everything it did not own.
      expect((row.configPublic as any).fromName).toBe('Beta Destek');
      expect((row.configPublic as any).imapLastUid).toBe(90);

      await health.recordOk(ref, 'receive', { polled: true });
      const healed = await channelRow(chB);
      expect(readMailboxHealth(healed.configPublic).consecutiveFailures).toBe(0);
      expect(isMailboxBackedOff(healed.configPublic)).toBe(false);
      expect(readMailboxHealth(healed.configPublic).lastPolledAt).toBeTruthy();
    });
  });
});
