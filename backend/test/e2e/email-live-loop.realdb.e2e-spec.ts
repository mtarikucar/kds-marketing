/**
 * The email programme against a REAL mail server, over the REAL wire.
 *
 * Every other email suite in this repo — the unit specs, `email-inbound`,
 * `email-journey`, `campaign-journey` — cuts the transport. `nodemailer` is
 * stubbed, `ImapFlow` is `jest.mock`ed, `EmailService` is replaced with a
 * recorder. That is the right seam for testing rules, and it means NOTHING in
 * this repository has ever proved that the bytes we build are bytes a mail
 * server accepts, or that the bytes a mail server hands back are bytes we can
 * read. A stub answers whatever the spec told it to; SMTP and IMAP do not.
 *
 * So this lane runs the product against `greenmail/standalone:2.1.0` (a real
 * SMTP + IMAP server) and a real, throwaway Postgres, and proves the whole
 * loop on the wire:
 *
 *   connect the mailbox (real SMTP AUTH + real IMAP login)
 *     → the customer writes in            (real SMTP delivery → real IMAP poll)
 *     → the gateway answers               (real SMTP send → read back over IMAP)
 *     → the customer replies              (real SMTP → real IMAP → same thread)
 *     → a bounce arrives                  (real DSN → classified → suppressed)
 *     → the next send is refused          (and nothing leaves the building)
 *     → a bulk mail's own unsubscribe link stops the one after it
 *
 * ## What is asserted, and why it cannot pass vacuously
 *
 * Every outbound claim is checked by FETCHING THE MESSAGE BACK out of the
 * recipient's mailbox over IMAP and reading the headers the server stored —
 * `From`, the RFC 2047-encoded display name, `Reply-To`, `Message-ID`,
 * `In-Reply-To`, `References`, `List-Unsubscribe`. A receipt that says SENT
 * proves nothing here; a message in the recipient's INBOX does.
 *
 * Every "we did not send this" claim is checked the same way, in reverse: the
 * recipient's mailbox is counted before and after, so a refusal that leaked a
 * mail anyway fails, and so does a refusal that was never reached because some
 * earlier step silently did nothing.
 *
 * Nothing is reached past. The mailbox is connected through
 * `ChannelsService.create` (which runs the real SSRF host guard, the real
 * credential validation, the real SMTP verify and the real IMAP probe, and is
 * the only writer of `lastVerifiedAt`). Inbound goes through
 * `EmailImapPollService`. Outbound goes through `OutboundMailService`. The
 * suppression verdicts are read back through `SuppressionService`. The
 * unsubscribe is POSTed to the public route, with the token taken OFF THE WIRE
 * — the link the recipient actually received is the link that has to work.
 *
 * ## The two things the environment forced, both of them the product's own rules
 *
 * 1. **IMAPS on port 993, reached on the container's own IP.** `imap-target.ts`
 *    requires STARTTLS on any non-993/994 port (`doSTARTTLS: true` — deliberate:
 *    without it imapflow would send LOGIN in the clear). GreenMail has no
 *    STARTTLS at all; it offers implicit TLS only. And `imapTarget` derives
 *    `secure` FROM THE PORT NUMBER, so the port the product connects to has to
 *    really be 993. A published host port cannot be 993 without squatting a
 *    privileged, shared port, so the container is given its own /24 and its own
 *    address instead, and 993 is its own. Nothing is published for IMAP, so
 *    nothing on this machine can collide with it.
 *
 * 2. **A resolvable, non-private host name.** `email-config.util.ts` refuses a
 *    bare IP outright and refuses any name that resolves inside a private
 *    network (the `smtp-ssrf` guard). That is correct and is not bypassed here:
 *    the container sits on a subnet the guard considers public and is named
 *    through `sslip.io`, which resolves `11-77-x-2.sslip.io` to `11.77.x.2`.
 *    The guard runs for real, does its real DNS lookup, and passes for a real
 *    reason. (This is the lane's one external dependency; `beforeAll` fails
 *    loudly and by name if that lookup does not answer.)
 *
 * GreenMail presents a self-signed certificate whose CN is "GreenMail
 * selfsigned Test Certificate" and which carries no SAN at all, so no trust
 * store and no host name can ever validate it — this lane therefore accepts it,
 * by patching `tls.connect` FOR THIS ONE HOST NAME and restoring it in
 * `afterAll`. That is the harness trusting the throwaway server's certificate,
 * the equivalent of installing it; the handshake, the IMAP LOGIN and everything
 * above them are the product's own, unmodified.
 * (`NODE_TLS_REJECT_UNAUTHORIZED` is not an option here: jest's node
 * environment hands the suite a COPY of `process.env`, so a write to it is
 * invisible to Node's own TLS internals — which is itself worth knowing, since
 * it is why an env var set inside a spec can appear to do nothing.)
 *
 * ## Isolation
 *
 * Both containers are this run's own and are force-removed in `afterAll` even
 * when a test threw. Postgres is published on a RANDOM high loopback port; the
 * mail server is published on a random high loopback port for SMTP and is
 * otherwise reachable only on the /24 this run created for it, whose third
 * octet is random — so two copies of this lane, or this lane beside anything
 * else on the machine, cannot contend for an address or a port. No container,
 * port, network or database that this file did not create is ever touched — in
 * particular the ambient `DATABASE_URL` the other real-DB lanes share is saved
 * and restored, and never written to. Cleanup is the container going away, so
 * there is no row-by-row teardown to drift out of date.
 *
 * Opt-in via E2E_REAL_DB=1, like every other real-DB lane. It additionally
 * skips (loudly) when the Docker daemon is not reachable, so the CI real-DB job
 * cannot go red on a runner without one.
 */
import { execFileSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { promises as dns } from 'dns';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import * as nodemailer from 'nodemailer';
import request from 'supertest';

import { PrismaService } from '../../src/prisma/prisma.service';
import { ChannelsService } from '../../src/modules/marketing/channels/channels.service';
import { EmailImapPollService } from '../../src/modules/marketing/channels/email-imap-poll.service';
import { signLeadUnsubscribeToken } from '../../src/modules/marketing/channels/lead-unsubscribe.token';
import { OutboundMailService } from '../../src/modules/marketing/channels/outbound/outbound-mail.service';
import { SuppressionService } from '../../src/modules/marketing/compliance/suppression.service';
import { MarketingEventTypes } from '../../src/modules/marketing/events/marketing-event-types';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

// ── the lane's gate ─────────────────────────────────────────────────────────

const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.0';
const POSTGRES_IMAGE = 'postgres:16-alpine';

/**
 * `require`, not `import * as tls` — and the difference is load-bearing.
 *
 * The TLS patch below has to reach the SAME module object `imapflow` holds
 * (`require('node:tls')`). An `import * as` is compiled to
 * `_interopRequireWildcard`, which hands back a fresh object COPIED from the
 * module's exports, so patching that copy changes nothing anybody else sees —
 * a silent no-op that reads exactly like a certificate the server did not
 * present.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tlsModule: typeof import('tls') = require('tls');

function dockerUsable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = realDbEnabled() && dockerUsable();
if (realDbEnabled() && !HAVE_DOCKER) {
  // Loud on purpose: a silent skip of the one suite that talks to a real mail
  // server is indistinguishable from a suite that passed.
  // eslint-disable-next-line no-console
  console.warn(
    '[email-live-loop] SKIPPED: the Docker daemon is not reachable, so no throwaway mail server or database could be started.',
  );
}
const describeLive = HAVE_DOCKER ? describe : describe.skip;

// ── identities ──────────────────────────────────────────────────────────────

const SEED = `e2e${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TENANT_DOMAIN = `acme-${SEED}.test`;
const PLATFORM_DOMAIN = `jeeta-${SEED}.test`;
const CUSTOMER_DOMAIN = `musteri-${SEED}.test`;

/** The workspace's own mailbox, which GreenMail creates on first login. */
const TENANT_ADDRESS = `destek@${TENANT_DOMAIN}`;
const MAILBOX_PASSWORD = 'greenmail-not-a-real-password';

/** The platform's own sender — a DIFFERENT domain, because `assertEmailSecrets`
 *  refuses a tenant mailbox on the platform's own sending domain. */
const PLATFORM_ADDRESS = `no-reply@${PLATFORM_DOMAIN}`;
const PLATFORM_NAME = 'Jeeta';

const CUSTOMER = `deniz@${CUSTOMER_DOMAIN}`;
/** The address the DSN reports as dead. */
const BOUNCER = `giden@${CUSTOMER_DOMAIN}`;
/** The address that unsubscribes itself out of the bulk lane. */
const SUBSCRIBER = `abone@${CUSTOMER_DOMAIN}`;

/** Non-ASCII on purpose: the display name has to survive RFC 2047 on the wire. */
const WORKSPACE_NAME = 'Acme Fırın';
const PUBLIC_BASE = 'https://live-loop.test';

// ── tiny docker helpers ─────────────────────────────────────────────────────

function docker(args: string[], timeout = 180_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout }).trim();
}

function dockerQuiet(args: string[]): void {
  try {
    execFileSync('docker', args, { stdio: 'ignore', timeout: 60_000 });
  } catch {
    /* teardown is best-effort — a container that is already gone is fine */
  }
}

function haveImage(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** The host port Docker chose for a container port published as `0`. */
function publishedPort(container: string, containerPort: string): number {
  const out = docker(['port', container, containerPort], 30_000);
  const line = out.split('\n').find((l) => l.includes('127.0.0.1')) ?? out.split('\n')[0];
  const port = Number(line.trim().split(':').pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not read the published port for ${container}:${containerPort} (docker said "${out}")`);
  }
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until something is listening, or say which address never answered. */
async function waitForPort(host: string, port: number, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (v: boolean, err?: string) => {
        if (err) last = err;
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(2_000);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false, 'timeout'));
      socket.once('error', (e: any) => done(false, String(e?.code ?? e?.message ?? e)));
    });
    if (ok) return;
    await sleep(300);
  }
  throw new Error(`${what} never accepted a connection on ${host}:${port} (last error: ${last || 'none'})`);
}

// ── the outside world: a mail client that is NOT the product ────────────────

/**
 * Send one message INTO GreenMail as somebody who is not us — the customer's
 * own mail client, or their provider's bounce daemon. Deliberately raw
 * nodemailer with no product code anywhere near it: this is the other end of
 * the wire, and it has to be able to be wrong in ways the product is not.
 */
async function deliver(
  smtpPort: number,
  smtpHost: string,
  envelope: { from: string; to: string },
  message: { raw: string } | Record<string, unknown>,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: false,
    auth: { user: envelope.from, pass: MAILBOX_PASSWORD },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({ envelope, ...(message as any) });
  } finally {
    transport.close();
  }
}

/** One message as the server actually stored it. */
interface StoredMail {
  uid: number;
  raw: string;
  parsed: ParsedMail;
  /** A raw header value, unfolded, exactly as the server kept it. */
  header(name: string): string | null;
}

function headerOf(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  // Unfold first, so a long References chain is one value rather than three.
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0 && line.slice(0, at).trim().toLowerCase() === name.toLowerCase()) {
      return line.slice(at + 1).trim();
    }
  }
  return null;
}

/**
 * Read a mailbox back out of GreenMail over IMAPS.
 *
 * The test's own client, not the product's: an assertion about what arrived
 * must not be able to inherit a bug from the code that put it there.
 */
async function readMailbox(imapHost: string, address: string): Promise<StoredMail[]> {
  const client = new ImapFlow({
    host: imapHost,
    port: 993,
    secure: true,
    auth: { user: address, pass: MAILBOX_PASSWORD },
    logger: false,
    greetingTimeout: 20_000,
    connectionTimeout: 20_000,
    socketTimeout: 20_000,
  } as any);
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true } as any);
    try {
      const uids = (await (client as any).search({ all: true }, { uid: true })) || [];
      const out: StoredMail[] = [];
      for (const uid of uids) {
        const msg: any = await (client as any).fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!msg?.source) continue;
        const raw = msg.source.toString('utf8');
        out.push({
          uid: Number(uid),
          raw,
          parsed: await simpleParser(raw),
          header: (name: string) => headerOf(raw, name),
        });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** A real RFC 3464 report — one field block per recipient, as the RFC says. */
function dsnFor(recipient: string, reportedBy: string): string {
  const body = [
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `This is the mail system at host ${reportedBy}.`,
    '',
    '--b',
    'Content-Type: message/delivery-status',
    '',
    `Reporting-MTA: dns; ${reportedBy}`,
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    '--b--',
  ].join('\r\n');
  return [
    `From: Mail Delivery System <MAILER-DAEMON@${CUSTOMER_DOMAIN}>`,
    `To: ${TENANT_ADDRESS}`,
    'Subject: Undelivered Mail Returned to Sender',
    `Message-ID: <dsn-${SEED}@${CUSTOMER_DOMAIN}>`,
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
    '',
    body,
  ].join('\r\n');
}

// ────────────────────────────────────────────────────────────────────────────

describeLive('Email live loop — a REAL SMTP/IMAP server and a real DB (e2e)', () => {
  const runId = randomUUID().slice(0, 8);
  const pgName = `jeeta-e2e-pg-${runId}`;
  const mailName = `jeeta-e2e-mail-${runId}`;
  const netName = `jeeta-e2e-net-${runId}`;

  /** A subnet the SSRF guard considers public (so the real guard can pass for a
   *  real reason) and that no bridge on this machine uses. */
  const subnetOctet = 1 + Math.floor(Math.random() * 250);
  const mailIp = `11.77.${subnetOctet}.2`;
  const mailHost = `11-77-${subnetOctet}-2.sslip.io`;

  /**
   * The port the PRODUCT dials. The container's own, because the product
   * reaches it on the container's own address (see the header) — a published
   * host port only exists on 127.0.0.1 and is refused from anywhere else.
   */
  const mailSmtpPort = 3025;
  /** The random high loopback port the TEST's own mail client dials. */
  let hostSmtpPort = 0;

  /** Restored in afterAll — see the note about the self-signed certificate. */
  const realTlsConnect = tlsModule.connect;

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let channels: ChannelsService;
  let poller: EmailImapPollService;
  let outbound: OutboundMailService;
  let suppression: SuppressionService;

  const workspaceId = randomUUID();
  /** A second workspace with NO mailbox, so its mail takes the platform lane. */
  const platformWorkspaceId = randomUUID();
  const packageId = randomUUID();
  const ownerId = randomUUID();
  const platformOwnerId = randomUUID();

  let channelId = '';
  let conversationId = '';
  let leadId = '';
  /** The Message-ID of the customer's first mail, as the server stored it. */
  let customerMessageId = '';
  /** The Message-ID the gateway put on our answer, as the server stored it. */
  let ourReplyMessageId = '';

  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string) => {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  };

  beforeAll(async () => {
    // 0. The one thing outside this machine. Named, so a DNS outage reads as a
    //    DNS outage rather than as "the mail server never came up".
    const resolved = await dns.lookup(mailHost, { all: true }).catch(() => []);
    if (!resolved.some((r) => r.address === mailIp)) {
      throw new Error(
        `this lane resolves its throwaway mail server through sslip.io: ${mailHost} must resolve to ${mailIp}, ` +
          `and it answered ${JSON.stringify(resolved)}. (The product refuses an IP literal and refuses a ` +
          `private address — see email-config.util.ts — so a resolvable public name is required.)`,
      );
    }

    // 1. A throwaway Postgres on a RANDOM high loopback port.
    if (!haveImage(POSTGRES_IMAGE)) docker(['pull', POSTGRES_IMAGE], 600_000);
    docker([
      'run', '-d', '--name', pgName,
      '-e', 'POSTGRES_USER=e2e', '-e', 'POSTGRES_PASSWORD=e2e', '-e', 'POSTGRES_DB=e2e',
      '-p', '127.0.0.1:0:5432',
      POSTGRES_IMAGE,
    ]);
    const pgPort = publishedPort(pgName, '5432');
    await waitForPort('127.0.0.1', pgPort, 'the throwaway Postgres');
    for (let i = 0; i < 60; i++) {
      try {
        execFileSync('docker', ['exec', pgName, 'pg_isready', '-U', 'e2e'], { stdio: 'ignore', timeout: 10_000 });
        break;
      } catch {
        await sleep(500);
      }
    }
    const databaseUrl = `postgresql://e2e:e2e@127.0.0.1:${pgPort}/e2e?schema=public`;

    // The schema, through the same command the deploy runs.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
      timeout: 300_000,
    });

    // 2. A throwaway mail server, on its own network so nothing can collide.
    if (!haveImage(GREENMAIL_IMAGE)) docker(['pull', GREENMAIL_IMAGE], 900_000);
    docker(['network', 'create', '--subnet', `11.77.${subnetOctet}.0/24`, netName]);
    docker([
      'run', '-d', '--name', mailName,
      '--network', netName, '--ip', mailIp,
      // SMTP is published on a random high loopback port as well, so the
      // customer's "mail client" below reaches it the ordinary way.
      '-p', '127.0.0.1:0:3025',
      '-e',
      // `setup.test.smtp` gives SMTP on 3025; IMAPS is declared on its own so it
      // can sit on 993 — `imapTarget()` decides implicit TLS from the PORT, and
      // GreenMail speaks no STARTTLS. `auth.disabled` is what makes GreenMail
      // create a mailbox on first login, which is how the tenant, the customer
      // and the bounce daemon all come into existence here.
      'GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.imaps.hostname=0.0.0.0 ' +
        '-Dgreenmail.imaps.port=993 -Dgreenmail.auth.disabled -Dgreenmail.hostname=0.0.0.0',
      GREENMAIL_IMAGE,
    ]);
    hostSmtpPort = publishedPort(mailName, '3025');
    await waitForPort('127.0.0.1', hostSmtpPort, "GreenMail's SMTP (published)");
    await waitForPort(mailIp, mailSmtpPort, "GreenMail's SMTP (on its own address)");
    await waitForPort(mailIp, 993, "GreenMail's IMAPS");

    // Accept THIS host's certificate and nothing else's. GreenMail's is
    // self-signed with no SAN and a CN that is not a host name, so neither a
    // CA bundle nor a matching name can ever be arranged for it.
    (tlsModule as any).connect = function patchedConnect(this: unknown, ...args: any[]) {
      const opts = args[0] && typeof args[0] === 'object' ? args[0] : null;
      if (opts && opts.host === mailHost) {
        opts.rejectUnauthorized = false;
        opts.checkServerIdentity = () => undefined;
      }
      return (realTlsConnect as any).apply(this, args);
    };

    // 3. The environment, all of it BEFORE the app boots: PrismaService reads
    //    DATABASE_URL in its constructor, EmailService builds its transport in
    //    its own, and `resolveConfig` opens an AES-256-GCM box with
    //    MARKETING_SECRET_KEY — without which the channel's secrets are
    //    unreadable and every assertion below would pass on an empty mailbox.
    setEnv('DATABASE_URL', databaseUrl);
    setEnv('MARKETING_SECRET_KEY', randomBytes(32).toString('base64'));
    setEnv('PUBLIC_BASE_URL', PUBLIC_BASE);
    setEnv('EMAIL_FROM', PLATFORM_ADDRESS);
    setEnv('EMAIL_FROM_NAME', PLATFORM_NAME);
    setEnv('EMAIL_HOST', mailHost);
    setEnv('EMAIL_PORT', String(mailSmtpPort));
    setEnv('EMAIL_SECURE', 'false');
    setEnv('EMAIL_USER', PLATFORM_ADDRESS);
    setEnv('EMAIL_PASSWORD', MAILBOX_PASSWORD);

    ({ app, prisma } = await createRealDbTestApp());
    channels = app.get(ChannelsService);
    poller = app.get(EmailImapPollService);
    outbound = app.get(OutboundMailService);
    suppression = app.get(SuppressionService);

    // Silence every cron: the five-minute platform-wide IMAP sweep would poll
    // this mailbox mid-assertion, and the job runner would fire batches nobody
    // asked for.
    const scheduler = app.get(SchedulerRegistry);
    for (const [, cron] of scheduler.getCronJobs()) {
      try {
        (cron as { stop?: () => void }).stop?.();
      } catch {
        /* a cron that will not stop is not this spec's problem to fix */
      }
    }

    // 4. Two tenants: one with its own mailbox, one deliberately without.
    await prisma.workspace.createMany({
      data: [
        {
          id: workspaceId,
          slug: `${SEED}-a`,
          name: WORKSPACE_NAME,
          productName: 'Acme POS',
          status: 'ACTIVE',
          defaultLanguage: 'tr',
        },
        {
          id: platformWorkspaceId,
          slug: `${SEED}-b`,
          name: 'Beta Kasap',
          productName: 'Beta POS',
          status: 'ACTIVE',
          defaultLanguage: 'tr',
        },
      ],
    });
    await prisma.package.create({
      data: {
        id: packageId,
        code: `PKG-${SEED}`,
        name: 'Live Loop Plan',
        dailyLeadQuota: 1000,
        maxUsers: 50,
        maxResearchProfiles: 10,
        // `conversationAi` is what gates connecting an EMAIL channel at all.
        features: { conversationAi: true, campaigns: true, workflows: true },
        // Real metering, not a stub: -1 is a plan with unlimited messages, which
        // is a state the product has, rather than a MessageQuotaService that
        // cannot say no.
        limits: { messagesMonthly: -1 },
        priceMonthlyTRY: 0,
        priceMonthlyUSD: 0,
      },
    });
    const now = new Date();
    await prisma.workspaceSubscription.createMany({
      data: [workspaceId, platformWorkspaceId].map((id) => ({
        workspaceId: id,
        packageId,
        status: 'ACTIVE',
        currency: 'USD',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      })),
    });
    await prisma.marketingUser.createMany({
      data: [
        {
          id: ownerId,
          workspaceId,
          email: `sahip-${SEED}@${TENANT_DOMAIN}`,
          password: 'seed-not-a-real-hash',
          firstName: 'Olcay',
          lastName: 'Owner',
          role: 'OWNER',
          status: 'ACTIVE',
        },
        {
          // The SYSTEM sentinel owns the "new conversation" lead-activity note.
          id: randomUUID(),
          workspaceId,
          email: `system-${SEED}@${TENANT_DOMAIN}`,
          password: 'seed-not-a-real-hash',
          firstName: 'System',
          lastName: 'Sentinel',
          role: 'SYSTEM',
          status: 'ACTIVE',
        },
        {
          id: platformOwnerId,
          workspaceId: platformWorkspaceId,
          email: `sahip-${SEED}@beta-${SEED}.test`,
          password: 'seed-not-a-real-hash',
          firstName: 'Bora',
          lastName: 'Owner',
          role: 'OWNER',
          status: 'ACTIVE',
        },
      ],
    });
    await prisma.workspaceMembership.createMany({
      data: [
        { userId: ownerId, workspaceId, role: 'OWNER', status: 'ACTIVE' },
        { userId: platformOwnerId, workspaceId: platformWorkspaceId, role: 'OWNER', status: 'ACTIVE' },
      ],
    });
  }, 900_000);

  afterAll(async () => {
    try {
      await closeTestApp(app);
    } finally {
      (tlsModule as any).connect = realTlsConnect;
      // Unconditional, and in this order: the network cannot go until the
      // container on it has. Both are force-removed, so a failed test still
      // leaves nothing behind.
      dockerQuiet(['rm', '-f', '-v', mailName]);
      dockerQuiet(['rm', '-f', '-v', pgName]);
      dockerQuiet(['network', 'rm', netName]);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 180_000);

  // ── helpers bound to this run ─────────────────────────────────────────────

  const inbox = (address: string) => readMailbox(mailHost, address);
  const deliverTo = (from: string, to: string, message: Record<string, unknown>) =>
    deliver(hostSmtpPort, '127.0.0.1', { from, to }, message);

  /** Everything the mailbox holds for one address, counted. */
  const mailCount = async (address: string) => (await inbox(address)).length;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Connecting the mailbox — the real SMTP AUTH and the real IMAP login.
  // ──────────────────────────────────────────────────────────────────────────

  it('1) connects the workspace mailbox by actually proving it against the server', async () => {
    const created: any = await channels.create(workspaceId, {
      type: 'EMAIL',
      name: 'Acme destek kutusu',
      externalId: TENANT_ADDRESS,
      secrets: {
        smtpHost: mailHost,
        smtpPort: String(mailSmtpPort),
        smtpUser: TENANT_ADDRESS,
        smtpPass: MAILBOX_PASSWORD,
        fromEmail: TENANT_ADDRESS,
        imapHost: mailHost,
        imapPort: '993',
        imapUser: TENANT_ADDRESS,
        imapPass: MAILBOX_PASSWORD,
      },
    } as any);

    channelId = created.id;
    expect(channelId).toBeTruthy();

    // Not "it did not throw": the adapter dialled both servers and each one
    // answered. `send` is a real SMTP EHLO+AUTH, `receive` a real IMAP LOGIN
    // plus an EXAMINE of INBOX.
    expect(created.health).toMatchObject({ ok: true });
    expect(created.health.details).toMatchObject({
      transport: 'smtp',
      host: mailHost,
      from: TENANT_ADDRESS,
      send: true,
      receive: true,
      imapHost: mailHost,
    });

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    // The single writer of this column, and the column every inbound path and
    // the whole mailbox-transport ladder select on.
    expect(row.lastVerifiedAt).toBeTruthy();
    expect(row.status).toBe('ACTIVE');
    // Nothing proved this workspace owns the address (no VERIFIED SendingDomain),
    // so the claim is PARKED rather than taken — sending is unaffected.
    expect(row.externalId).toBeNull();
    expect((row.configPublic as any).pendingAddress).toBe(TENANT_ADDRESS);
  }, 120_000);

  it('2) a first tick against the real mailbox takes nothing and leaves a cursor', async () => {
    const ingested = await poller.pollOne(workspaceId, channelId);
    // `null` would mean "this channel is not IMAP-pollable" — which is what a
    // wrong port, a refused login or an unresolvable host would produce, and is
    // exactly the silent skip that would make every later assertion vacuous.
    expect(ingested).toBe(0);

    const pub = (await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })).configPublic as any;
    // UIDVALIDITY came off the live mailbox, so the next tick RESUMES rather
    // than treating itself as a first run.
    expect(String(pub.imapUidValidity)).toMatch(/^\d+$/);
    expect(pub.imapLastUid).toBe(0);
  }, 60_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Inbound: a real delivery, read back by the real poller.
  // ──────────────────────────────────────────────────────────────────────────

  it('3) a cold stranger is read off the server, recorded, and deliberately not made a lead', async () => {
    // A mailbox connected from now on starts on REPLIES_AND_KNOWN, so the
    // supplier, the accountant and the calendar invite do not each become a
    // lead in a nurture sequence. That is the state a real tenant is in the
    // minute after connecting, so it is the state this lane starts from.
    const coldId = `soguk-${SEED}@${CUSTOMER_DOMAIN}`;
    await deliverTo(`soguk@${CUSTOMER_DOMAIN}`, TENANT_ADDRESS, {
      from: { name: 'Bilinmeyen Tedarikçi', address: `soguk@${CUSTOMER_DOMAIN}` },
      to: TENANT_ADDRESS,
      subject: 'Katalog',
      text: 'Merhaba, katalogumuzu ekte gönderiyoruz.',
      messageId: `<${coldId}>`,
    });

    const ingested = await poller.pollOne(workspaceId, channelId);
    expect(ingested).toBe(0);

    // Recorded, not dropped: the ledger row is what carries the one-click
    // "make this a lead", and it is the difference between a policy and a hole.
    const item = await prisma.emailInboundItem.findFirstOrThrow({
      where: { workspaceId, channelId, messageId: coldId },
    });
    expect(item.state).toBe('SKIPPED');
    expect(item.reason).toBe('policy-not-a-lead');
    expect(item.fromAddress).toBe(`soguk@${CUSTOMER_DOMAIN}`);

    expect(await prisma.lead.count({ where: { workspaceId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { workspaceId } })).toBe(0);
  }, 120_000);

  it('4) a customer we already have writes in: one lead, a thread and an AI cue', async () => {
    // Entered by hand or imported long before the mailbox existed — which is
    // the case that used to produce a SECOND lead for the same person the
    // moment they wrote in.
    const known = await prisma.lead.create({
      data: {
        workspaceId,
        businessName: 'Yılmaz Kahve',
        contactPerson: 'Deniz Yılmaz',
        businessType: 'CAFE',
        source: 'IMPORT',
        status: 'NEW',
        email: CUSTOMER.toUpperCase(),
        emailNormalized: CUSTOMER,
      },
      select: { id: true },
    });

    customerMessageId = `ilk-${SEED}@${CUSTOMER_DOMAIN}`;
    await deliverTo(CUSTOMER, TENANT_ADDRESS, {
      from: { name: 'Deniz Yılmaz', address: CUSTOMER },
      to: TENANT_ADDRESS,
      subject: 'Fiyat listesi',
      text: 'Merhaba, fiyat listesini alabilir miyim?',
      messageId: `<${customerMessageId}>`,
    });

    const ingested = await poller.pollOne(workspaceId, channelId);
    expect(ingested).toBe(1);

    const message = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalMessageId: customerMessageId },
    });
    expect(message.direction).toBe('INBOUND');
    expect(message.authorType).toBe('CUSTOMER');
    expect(message.body).toContain('Fiyat listesi');
    expect(message.body).toContain('fiyat listesini alabilir miyim');

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: message.conversationId },
    });
    conversationId = conversation.id;
    leadId = conversation.leadId!;
    expect(conversation.channelId).toBe(channelId);
    expect(conversation.status).toBe('OPEN');
    expect(conversation.unreadCount).toBe(1);

    const identity = await prisma.contactIdentity.findFirstOrThrow({
      where: { workspaceId, channelId, value: CUSTOMER },
    });
    expect(identity.leadId).toBe(leadId);

    // ADOPTION, matched on `emailNormalized` against a real index: the person
    // in the CRM and the person writing in are one lead, not two.
    expect(leadId).toBe(known.id);
    expect(await prisma.lead.count({ where: { workspaceId } })).toBe(1);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.emailNormalized).toBe(CUSTOMER);

    // The ledger row that answers "where did my customer's mail go?".
    const item = await prisma.emailInboundItem.findFirstOrThrow({
      where: { workspaceId, channelId, source: 'imap', messageId: customerMessageId },
    });
    expect(item.state).toBe('DONE');
    expect(item.fromAddress).toBe(CUSTOMER);

    // The cue the reply engine hangs off. Without it the mail lands and nothing
    // answers — the exact silence this whole programme exists to remove.
    const cue = await prisma.outboxEvent.findFirst({
      where: {
        type: MarketingEventTypes.ConversationMessageReceived,
        idempotencyKey: `conv-msg:${message.id}`,
      },
    });
    expect(cue).toBeTruthy();
    expect((cue!.payload as any).conversationId).toBe(conversationId);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Outbound (a): the gateway's mail, read back off the wire.
  // ──────────────────────────────────────────────────────────────────────────

  it("5) the gateway's 1:1 answer really arrives, carrying our From, name, id and thread", async () => {
    const receipt = await outbound.send({
      workspaceId,
      mailClass: 'CONVERSATIONAL',
      to: CUSTOMER,
      subject: 'Re: Fiyat listesi',
      text: 'Merhaba Deniz, listeyi ekte yolluyorum.',
      leadId,
      source: `conversation:${conversationId}`,
      thread: { conversationId, inReplyTo: customerMessageId, references: [customerMessageId] },
    });

    expect(receipt.outcome).toBe('SENT');
    expect(receipt.ok).toBe(true);
    // The workspace's OWN mailbox carried it, not the platform relay.
    expect(receipt.transport).toBe('MAILBOX_SMTP');
    ourReplyMessageId = receipt.messageId!;
    expect(ourReplyMessageId).toBeTruthy();

    // The ledger opened before the dispatch and settled after it.
    const log = await prisma.mailLog.findUniqueOrThrow({ where: { id: receipt.mailLogId } });
    expect(log.status).toBe('SENT');
    expect(log.transport).toBe('MAILBOX_SMTP');
    expect(log.channelId).toBe(channelId);
    expect(log.messageId).toBe(ourReplyMessageId);
    // Deterministic from the ledger row and OUR sending domain — this is what a
    // bounce report and a Sent-folder copy are matched back on.
    expect(ourReplyMessageId).toBe(`${log.id.toLowerCase()}@${TENANT_DOMAIN}`);

    // …and now the only thing that actually settles it: the mail is in the
    // customer's mailbox, and the server kept the headers we claim to send.
    const mails = await inbox(CUSTOMER);
    expect(mails).toHaveLength(1);
    const mail = mails[0];

    expect(mail.parsed.from?.value[0]?.address).toBe(TENANT_ADDRESS);
    // Round-tripped through RFC 2047 by nodemailer and back by mailparser — the
    // dotted-ı is what a hand-built `"name" <addr>` gets wrong.
    expect(mail.parsed.from?.value[0]?.name).toBe(WORKSPACE_NAME);
    expect(mail.header('From')).not.toContain('undefined');
    expect(mail.parsed.subject).toBe('Re: Fiyat listesi');
    expect(mail.header('Message-ID')).toBe(`<${ourReplyMessageId}>`);
    expect(mail.header('In-Reply-To')).toBe(`<${customerMessageId}>`);
    expect(mail.header('References')).toContain(`<${customerMessageId}>`);
    expect(mail.parsed.text).toContain('listeyi ekte yolluyorum');
    // A 1:1 mail is not a mailing list: no RFC 8058 pair, no footer.
    expect(mail.header('List-Unsubscribe')).toBeNull();
    // This transport IS the tenant; a Reply-To pointing somewhere else would be
    // the platform-relay shape leaking onto a mailbox send.
    expect(mail.header('Reply-To')).toBeNull();
  }, 120_000);

  it('6) platform-relay mail says whose it is and where a reply must land', async () => {
    const platformRecipient = `alici-${SEED}@${CUSTOMER_DOMAIN}`;
    const receipt = await outbound.send({
      workspaceId: platformWorkspaceId,
      mailClass: 'TRANSACTIONAL',
      to: platformRecipient,
      subject: 'Siparişiniz hazır',
      text: 'Siparişiniz hazırlandı.',
      source: 'invoice:live-loop',
    });

    // No mailbox on this workspace, so the ladder falls through to the platform
    // relay — which is the lane that used to send tenant copy under our own
    // name with no way back to the tenant.
    expect(receipt.outcome).toBe('SENT');
    expect(receipt.transport).toBe('PLATFORM');

    const mails = await inbox(platformRecipient);
    expect(mails).toHaveLength(1);
    const mail = mails[0];

    // The From address NEVER moves off the platform domain (DMARC alignment);
    // only the display name and the Reply-To may say whose mail it is.
    expect(mail.parsed.from?.value[0]?.address).toBe(PLATFORM_ADDRESS);
    expect(mail.parsed.from?.value[0]?.name).toBe(`Beta Kasap via ${PLATFORM_NAME}`);
    expect(mail.parsed.replyTo?.value[0]?.address).toBe(`sahip-${SEED}@beta-${SEED}.test`);
    expect(mail.parsed.text).toContain('Siparişiniz hazırlandı');
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Inbound (b): the reply comes back, into the same thread.
  // ──────────────────────────────────────────────────────────────────────────

  it('7) the customer replies over SMTP and it threads into the SAME conversation', async () => {
    const replyId = `yanit-${SEED}@${CUSTOMER_DOMAIN}`;
    await deliverTo(CUSTOMER, TENANT_ADDRESS, {
      from: { name: 'Deniz Yılmaz', address: CUSTOMER },
      to: TENANT_ADDRESS,
      subject: 'Re: Fiyat listesi',
      text: 'Teşekkürler, sipariş vermek istiyorum.\r\n\r\n> Merhaba Deniz, listeyi ekte yolluyorum.',
      messageId: `<${replyId}>`,
      inReplyTo: `<${ourReplyMessageId}>`,
      references: [`<${customerMessageId}>`, `<${ourReplyMessageId}>`],
    });

    const ingested = await poller.pollOne(workspaceId, channelId);
    expect(ingested).toBe(1);

    const reply = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalMessageId: replyId },
    });
    // The same thread the first mail opened — not a second conversation, which
    // is what a lost identity or a second lead would produce.
    expect(reply.conversationId).toBe(conversationId);
    expect(reply.direction).toBe('INBOUND');
    expect(reply.body).toContain('sipariş vermek istiyorum');
    // The quoted copy of our own mail is stripped, so the AI answers the
    // customer's words and not its own.
    expect(reply.body).not.toContain('listeyi ekte yolluyorum');

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.unreadCount).toBe(2);
    expect(conversation.lastInboundAt).toBeTruthy();
    expect(conversation.leadId).toBe(leadId);

    // Still ONE lead and ONE identity for this person, after two real deliveries.
    expect(await prisma.lead.count({ where: { workspaceId, emailNormalized: CUSTOMER } })).toBe(1);
    expect(await prisma.contactIdentity.count({ where: { workspaceId, value: CUSTOMER } })).toBe(1);

    // A human is actually rung about it, naming the lead.
    const bell = await prisma.marketingNotification.findFirst({
      where: {
        workspaceId,
        userId: ownerId,
        metadata: { path: ['conversationId'], equals: conversationId } as any,
      },
    });
    expect(bell).toBeTruthy();
    expect((bell!.metadata as any).leadId).toBe(leadId);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Inbound (c): a bounce is a bounce, not a customer.
  // ──────────────────────────────────────────────────────────────────────────

  it('8) a DSN in the tenant mailbox suppresses the address and creates no lead', async () => {
    const leadsBefore = await prisma.lead.count({ where: { workspaceId } });

    await deliverTo(`MAILER-DAEMON@${CUSTOMER_DOMAIN}`, TENANT_ADDRESS, {
      raw: dsnFor(BOUNCER, `mail.${CUSTOMER_DOMAIN}`),
    });

    const ingested = await poller.pollOne(workspaceId, channelId);
    // Read, classified, and deliberately NOT ingested.
    expect(ingested).toBe(0);

    const item = await prisma.emailInboundItem.findFirstOrThrow({
      where: { workspaceId, channelId, messageId: `dsn-${SEED}@${CUSTOMER_DOMAIN}` },
    });
    expect(item.state).toBe('SKIPPED');
    expect(item.reason).toBe('dsn');

    // No lead, no conversation, no identity for the daemon or for the address
    // it reported. A bounce that becomes a lead is a lead the AI then answers.
    expect(await prisma.lead.count({ where: { workspaceId } })).toBe(leadsBefore);
    expect(
      await prisma.lead.count({
        where: { workspaceId, emailNormalized: { in: [BOUNCER, `mailer-daemon@${CUSTOMER_DOMAIN}`] } },
      }),
    ).toBe(0);

    // The address is on the list — read back through the service, because the
    // stored row is a keyed HMAC and a raw-row assertion would prove only that
    // SOMETHING was written.
    const verdict = await suppression.check(workspaceId, BOUNCER, 'TRANSACTIONAL');
    expect(verdict).toMatchObject({ suppressed: true, reason: 'HARD_BOUNCE' });

    const rows = await prisma.contactSuppression.findMany({
      where: { workspaceId, kind: 'EMAIL', liftedAt: null },
      select: { reason: true, source: true },
    });
    expect(rows).toEqual([{ reason: 'HARD_BOUNCE', source: 'dsn' }]);

    // …and only that address. The customer we are mid-conversation with must
    // not be caught by somebody else's bounce.
    expect(await suppression.check(workspaceId, CUSTOMER, 'TRANSACTIONAL')).toEqual({ suppressed: false });
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Outbound (d): the suppressed address is refused, and nothing leaves.
  // ──────────────────────────────────────────────────────────────────────────

  it('9) the next send to the bounced address is refused, and no mail leaves', async () => {
    const before = await mailCount(BOUNCER);

    const receipt = await outbound.send({
      workspaceId,
      mailClass: 'TRANSACTIONAL',
      to: BOUNCER,
      subject: 'Faturanız',
      text: 'Faturanız ektedir.',
      source: 'invoice:live-loop-bounced',
    });

    expect(receipt.outcome).toBe('REFUSED');
    expect(receipt.ok).toBe(false);
    expect(receipt.reason).toBe('SUPPRESSED_BOUNCE');
    // Nothing carried it, so nothing claims to have.
    expect(receipt.transport).toBe('NONE');
    expect(receipt.retriable).toBe(false);

    // The refusal is VISIBLE — a row saying we did not send this and why.
    const log = await prisma.mailLog.findUniqueOrThrow({ where: { id: receipt.mailLogId } });
    expect(log.status).toBe('REFUSED');
    expect(log.reason).toBe('SUPPRESSED_BOUNCE');
    expect(log.toAddressNorm).toBe(BOUNCER);

    // And the mail server agrees: the mailbox is exactly as empty as it was.
    expect(await mailCount(BOUNCER)).toBe(before);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Outbound (e): bulk, its unsubscribe link, and the send after it.
  // ──────────────────────────────────────────────────────────────────────────

  it('10) a bulk mail arrives carrying the RFC 8058 header and its own footer link', async () => {
    const lead = await prisma.lead.create({
      data: {
        workspaceId,
        businessName: 'Abone Lokanta',
        contactPerson: 'Aylin Abone',
        businessType: 'RESTAURANT',
        source: 'IMPORT',
        status: 'NEW',
        email: SUBSCRIBER,
        emailNormalized: SUBSCRIBER,
      },
      select: { id: true },
    });
    // The product's own token, minted exactly as the drip sender mints it.
    const token = signLeadUnsubscribeToken(workspaceId, lead.id, 'EMAIL')!;
    expect(token).toBeTruthy();

    const receipt = await outbound.send({
      workspaceId,
      mailClass: 'BULK',
      to: SUBSCRIBER,
      subject: 'Bu haftanın menüsü',
      text: 'Bu hafta fırından çıkan her şey.',
      html: '<p>Bu hafta fırından çıkan her şey.</p>',
      leadId: lead.id,
      unsubscribe: { token, url: `${PUBLIC_BASE}/api/public/ul/${token}` },
      source: 'workflow:live-loop',
    });
    expect(receipt.outcome).toBe('SENT');
    expect(receipt.transport).toBe('MAILBOX_SMTP');

    const mails = await inbox(SUBSCRIBER);
    expect(mails).toHaveLength(1);
    const mail = mails[0];

    // One-click, on the wire, as the pair — a `-Post` without its partner is
    // the header that makes Gmail reject the whole thing.
    expect(mail.header('List-Unsubscribe')).toBe(`<${PUBLIC_BASE}/api/public/ul/${token}>`);
    expect(mail.header('List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
    // …and the same URL is in the body, in both parts, so a client that shows
    // no header button still gives the reader a way off the list.
    expect(mail.parsed.text).toContain(`${PUBLIC_BASE}/api/public/ul/${token}`);
    expect(mail.parsed.html).toContain(`${PUBLIC_BASE}/api/public/ul/${token}`);
    // The 6563 identity block: commercial mail has to name who sent it.
    expect(mail.parsed.text).toContain(WORKSPACE_NAME);
    expect(mail.parsed.text).toContain(SUBSCRIBER);
    // Bulk is not a reply: threading headers on one would graft a campaign into
    // somebody's existing thread.
    expect(mail.header('In-Reply-To')).toBeNull();
  }, 120_000);

  it('11) pressing the link that arrived stops the next bulk send dead', async () => {
    // The token is taken OFF THE WIRE rather than from a variable: the link the
    // recipient actually received is the link that has to work.
    const mail = (await inbox(SUBSCRIBER))[0];
    const url = mail.header('List-Unsubscribe')!.replace(/^<|>$/g, '');
    expect(url.startsWith(`${PUBLIC_BASE}/api/public/ul/`)).toBe(true);
    const routePath = url.slice(PUBLIC_BASE.length);

    const res = await request(app.getHttpServer()).post(routePath);
    expect(res.status).toBeLessThan(300);

    // The opt-out is recorded for the ADDRESS, with the consent trail behind it.
    expect(await suppression.check(workspaceId, SUBSCRIBER, 'BULK')).toMatchObject({
      suppressed: true,
      reason: 'OPT_OUT',
    });
    const lead = await prisma.lead.findFirstOrThrow({ where: { workspaceId, emailNormalized: SUBSCRIBER } });
    expect(lead.emailOptOut).toBe(true);
    const withdrawal = await prisma.consentRecord.findFirst({
      where: { workspaceId, leadId: lead.id, type: 'MARKETING_EMAIL', granted: false },
    });
    expect(withdrawal).toBeTruthy();

    // Now the send that must not happen.
    const before = await mailCount(SUBSCRIBER);
    const token = signLeadUnsubscribeToken(workspaceId, lead.id, 'EMAIL')!;
    const receipt = await outbound.send({
      workspaceId,
      mailClass: 'BULK',
      to: SUBSCRIBER,
      subject: 'Gelecek haftanın menüsü',
      text: 'Gelecek hafta fırından çıkan her şey.',
      leadId: lead.id,
      unsubscribe: { token, url: `${PUBLIC_BASE}/api/public/ul/${token}` },
      source: 'workflow:live-loop-2',
    });

    expect(receipt.outcome).toBe('REFUSED');
    expect(receipt.reason).toBe('SUPPRESSED_OPT_OUT');
    expect(receipt.transport).toBe('NONE');

    // The mail server is the witness: nothing new arrived.
    expect(await mailCount(SUBSCRIBER)).toBe(before);

    // …and the invoice for something they bought still reaches them. Unticking
    // marketing mail is not a refusal of the receipt: TRANSACTIONAL does not
    // gate on an opt-out, and that difference is the whole reason mail is
    // typed. Proved on the wire, not on a verdict object.
    const beforeInvoice = await mailCount(SUBSCRIBER);
    const invoice = await outbound.send({
      workspaceId,
      mailClass: 'TRANSACTIONAL',
      to: SUBSCRIBER,
      subject: 'Faturanız',
      text: 'Geçen haftaki siparişinizin faturası ektedir.',
      leadId: lead.id,
      source: 'invoice:live-loop-opted-out',
    });
    expect(invoice.outcome).toBe('SENT');
    expect(await mailCount(SUBSCRIBER)).toBe(beforeInvoice + 1);
  }, 120_000);
});
