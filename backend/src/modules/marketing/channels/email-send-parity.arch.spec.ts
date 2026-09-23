import * as fs from 'fs';
import * as path from 'path';
import { GATE_MATRIX, MAIL_CLASSES, MailClass } from './outbound/mail-class';

/**
 * Architecture-fitness test: EVERY outbound email leaves through the seam.
 *
 * Before this programme, each sender carried its own half-remembered subset of
 * the rules. A campaign fail-closed without an unsubscribe link while a
 * workflow drip went out with none at all; an invoice could be stopped by a
 * marketing opt-out; a password reset could be silenced by a stale bounce. The
 * parity was enforced by comments (`suppression-parity-test`), which is to say
 * it was not enforced.
 *
 * So this scans the tree for the two raw transport surfaces —
 * `EmailService.send*` and the EMAIL channel adapter's `send` — plus nodemailer
 * itself, and requires every call site to be one of:
 *
 *   1. THE SEAM — the gateway and the two transports it drives (`THE_SEAM`);
 *   2. an entry on the WRITTEN allow-list below (`NOT_ON_THE_GATEWAY`), each
 *      with a justification and, where one can be stated statically, the
 *      guarantee that made the exemption safe.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * It asserts THE MATRIX IS HONOURED, not that every caller is identical
 * (PLAN §A8). A universal funnel is the wrong answer and four verifiers said
 * so: an invoice must reach a customer who unticked marketing mail, a booking
 * confirmation must never acquire `List-Unsubscribe`, and routing 1:1 thread
 * mail through the bulk path causes four regressions. The seam is one ORDERED
 * GATE reading `GATE_MATRIX` as data — not one `send()`.
 *
 * The scan is a regex heuristic, in the house style of
 * `workspace-scoping.arch.spec.ts`: deliberately simple, failing LOUD on a new
 * call site, where the fix (route it through `OutboundMailService.send`) is
 * always the right move. Comments are stripped first so prose about
 * `sendPlainEmail` does not trip it; string literals are not, which is a
 * knowing trade for a detector nobody has to debug.
 */

const SRC_ROOT = path.resolve(__dirname, '../../..');

/** The raw surfaces. Anything that reaches one of these can put mail on a wire. */
type Surface = 'email-service' | 'email-adapter' | 'nodemailer';

interface CallSite {
  rel: string;
  line: number;
  surface: Surface;
  snippet: string;
}

/**
 * THE SEAM. Not exemptions — these files ARE the thing everyone else must go
 * through, and each is the single implementation of one layer.
 */
const THE_SEAM: Record<string, string> = {
  'common/services/email.service.ts':
    'the platform transport — it DEFINES sendPlainEmail/sendCampaignEmail/sendPlainEmailWithIcs and owns the shared nodemailer transporter, DKIM and mock mode',
  'common/util/list-unsubscribe.ts':
    'the RFC 8058 header pair, built in one place so `-Post` can never be emitted without `List-Unsubscribe`',
  'modules/marketing/channels/outbound/outbound-mail.service.ts':
    'THE GATEWAY — the only caller of both transports; runs the ordered gate, composes per class, writes the ledger and settles the receipt',
  'modules/marketing/channels/adapters/email.adapter.ts':
    "the mailbox transport — the EMAIL adapter's own nodemailer transport, reached through the registry",
};

interface Exemption {
  /** How many call sites this entry was written for. A new one re-opens the question. */
  sites: number;
  /** Why this one legitimately stays off the gateway. */
  why: string;
  /**
   * The guarantee that made the exemption safe, as something static analysis
   * can still see. An exemption whose guarantee has been edited away is not an
   * exemption any more, so these go red too.
   */
  requires?: { pattern: RegExp; guarantee: string }[];
}

/**
 * THE WRITTEN ALLOW-LIST — what deliberately does NOT move onto the gateway
 * (PLAN §A7). Four entries, each a named decision rather than a leftover.
 */
const NOT_ON_THE_GATEWAY: Record<string, Exemption> = {
  // ── The Handlebars path ────────────────────────────────────────────────────
  // `EmailService.sendEmail` renders a stored Handlebars template with a
  // context object; `OutboundMail` carries a composed `text`/`html` and has no
  // template field, by design — the gateway composes per mail CLASS (footer,
  // sender-identity block, threading headers), which a pre-rendered template
  // would fight rather than feed.
  //
  // The one live caller is the tenant-welcome mail sent after a lead is
  // converted into a CORE tenant. It is AUTH-shaped: the recipient is the new
  // tenant's admin, not a contact on anybody's marketing list, and the body
  // carries a one-time password. Every gate the matrix would apply to it is
  // `never` for AUTH anyway (no opt-out, no bounce suppression, no metering,
  // no unsubscribe header, platform identity only), so routing it through the
  // seam would buy a MailLog row and cost a rewrite of the template pipeline.
  // That MailLog row is worth having — see the handoff in the programme notes —
  // but it is a template-rendering change, not a parity hole.
  'modules/marketing/services/marketing-leads.service.ts:email-service': {
    sites: 1,
    why: 'AUTH-shaped Handlebars template send (tenant welcome + one-time password) — the gateway composes bodies, it does not render stored templates',
    requires: [
      {
        pattern: /template:\s*'marketing-tenant-welcome'/,
        guarantee: 'the exemption covers the tenant-welcome template send and nothing else',
      },
    ],
  },

  // ── Lane A: threaded 1:1 mail ──────────────────────────────────────────────
  // `MessageSenderService.send` owns the `Message` row, the SSE push to the
  // inbox, the SMS settlement and the quota pairing for EVERY channel — it is
  // the dispatcher, not a mailer, and EMAIL is one branch of it. Pulling its
  // adapter call into the gateway would either duplicate the Message row or
  // move four other channels onto an email gateway.
  //
  // What makes that safe is that the DECIDING cells of the CONVERSATIONAL
  // column are applied here, in the file, before the adapter is touched:
  //
  //  - `sendingPaused` — `emailPaused(settings)`, the same reader the gateway
  //    uses, so the operator kill switch stops the AI reply engine and the
  //    Inbox composer too (`paused-skips-1to1`).
  //  - `hardBounce`/`optOut`/`complaint` — the same `SuppressionService.check`
  //    the guard calls, with the same class, so the reply exemption (a customer
  //    who unsubscribed and then wrote in still gets an answer) behaves
  //    identically on both paths.
  //
  // The rest of the column is applied elsewhere or does not reach this lane,
  // and is NOT claimed here: `workspaceActive` by `quota.reserve`, which throws
  // WORKSPACE_INACTIVE; `quietHours` at queue time by
  // `ConversationFollowupService`, the only proactive sender on this lane;
  // `dailyCap` never, because that budget is the PLATFORM transport's and this
  // lane sends from the tenant's own mailbox; `mailLog` is a known gap, so the
  // ops snapshot under-reports conversational volume. If a cell asserted below
  // is ever edited out, this exemption stops applying and the assertion says so.
  'modules/marketing/channels/message-sender.service.ts:email-adapter': {
    sites: 1,
    why: 'the omnichannel dispatcher — it owns the Message row, the SSE push and the quota pairing for every channel; EMAIL is one branch, gated in-file with the same pause switch and CONVERSATIONAL suppression check the guard runs',
    requires: [
      {
        pattern: /suppression\.check\(/,
        guarantee: 'the EMAIL branch still asks SuppressionService before the adapter',
      },
      {
        pattern: /'CONVERSATIONAL'/,
        guarantee: 'it asks with the CONVERSATIONAL class, so the reply exemption still applies',
      },
      {
        pattern: /emailPaused\(/,
        guarantee: "the operator kill switch (`settings.email.paused`) still stops this lane",
      },
    ],
  },

  // ── The campaign sender's OTHER channels ───────────────────────────────────
  // This site is `registry.get(channelType).send(...)` where `channelType` is
  // SMS or WHATSAPP — the bulk sender's non-email leg, which the email
  // programme does not touch. Its EMAIL leg goes through the gateway
  // (`mailClass: 'BULK'`), which is what the `sites: 1` count pins: a second
  // dynamic adapter call in this file would be the EMAIL path sneaking back
  // out, and would re-open this question.
  'modules/marketing/campaigns/campaign-sender.service.ts:email-adapter': {
    sites: 1,
    why: "the SMS/WhatsApp leg of the bulk sender — `channelType` is never EMAIL; the EMAIL leg goes through the gateway as BULK",
    requires: [
      {
        pattern: /const channelType = [^\n;]*'WHATSAPP'/,
        guarantee: 'the dynamically-dispatched adapter resolves to SMS or WHATSAPP, never EMAIL',
      },
      {
        pattern: /mailClass:\s*'BULK'/,
        guarantee: "this file's email path is the gateway",
      },
    ],
  },

  // ── Text-to-pay ────────────────────────────────────────────────────────────
  // The same shape as the entry above, and the clearest one: `sendByText` takes
  // `channelType: 'SMS' | 'WHATSAPP'` and REFUSES anything else at runtime
  // before it reaches the registry. There is no email path in this file to
  // migrate — an invoice's email lives in `document-email.service.ts`, which is
  // TRANSACTIONAL through the gateway.
  'modules/marketing/invoicing/invoice-text.service.ts:email-adapter': {
    sites: 1,
    why: 'text-to-pay over SMS/WhatsApp — the channel type is refused at runtime unless it is one of those two; the invoice EMAIL path is document-email.service.ts',
    requires: [
      {
        pattern: /channelType !== 'SMS' && channelType !== 'WHATSAPP'/,
        guarantee: 'EMAIL is still refused before the registry is touched',
      },
    ],
  },

  // ── The mailbox transport wrapper ──────────────────────────────────────────
  // `WorkspaceMailboxService.send` is the "send through the tenant's own
  // mailbox, or answer null" helper. The gateway resolves the identity through
  // `SenderIdentityService` and drives the adapter itself, so this method
  // currently has NO production caller — and that is exactly the condition of
  // the exemption. It is allow-listed rather than deleted because the file
  // belongs to another package this wave; the cross-file assertion below
  // enforces the part that matters: nothing outside `channels/outbound/` may
  // start calling it, because that would be a send with no gate in front of it.
  'modules/marketing/channels/workspace-mailbox.service.ts:email-adapter': {
    sites: 1,
    why: 'the mailbox-transport helper. It has no production caller — the gateway drives the adapter itself — and the assertion below keeps it that way',
  },
};

/**
 * Every gateway caller, pinned to the mail class(es) it sends.
 *
 * This is the "matrix is honoured" half. The classes are not decoration: they
 * ARE the gate set (§A1). A digest that became BULK would start metering
 * against the tenant's plan and carrying an unsubscribe header for our own
 * product; an invoice that became BULK would be stopped by a marketing
 * opt-out. Both are silent, both are one word, and both are caught here.
 */
const GATEWAY_CALLERS: Record<string, MailClass[]> = {
  // Mail about OUR product to OUR user: no tenant Reply-To, not metered.
  'modules/marketing/analytics/daily-digest.cron.ts': ['INTERNAL'],
  'modules/marketing/services/membership.service.ts': ['INTERNAL'],
  // The tenant's business mail to one named customer — plus the tenant-facing
  // notification that a customer answered, which is INTERNAL.
  'modules/marketing/invoicing/document-email.service.ts': ['TRANSACTIONAL', 'INTERNAL'],
  // Customer booking mail is TRANSACTIONAL; the HOST leg is INTERNAL.
  'modules/marketing/sites/booking.service.ts': ['TRANSACTIONAL', 'INTERNAL'],
  // Account/security. Platform identity, gated by nothing a tenant can set.
  'modules/marketing/services/marketing-auth.service.ts': ['AUTH'],
  // Marketing to a list — the CRITICAL. Both of these fail closed without an
  // unsubscribe mechanism.
  'modules/marketing/workflows/workflow-action.handler.ts': ['BULK'],
  'modules/marketing/campaigns/campaign-sender.service.ts': ['BULK'],
  // The pre-launch rehearsal: one copy of a campaign to the operator about to
  // launch it, and the card's `preflight()`. BULK on purpose — a test that
  // skipped the bulk gates would rehearse a mail the real send never makes.
  'modules/marketing/campaigns/campaign-preview.service.ts': ['BULK'],
};

// ── the detector ─────────────────────────────────────────────────────────────

/**
 * `X.sendPlainEmail(` / `X.sendCampaignEmailResult(` / `X.sendEmail(` …
 *
 * The receiver is captured so a service's own private `this.sendEmail(...)`
 * helper — which both the campaign sender and the workflow handler have — is
 * not mistaken for a transport call.
 */
const EMAIL_SERVICE_RE =
  /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.send(?:PlainEmailWithIcs|PlainEmail|CampaignEmail|Email)(?:Result)?\s*\(/g;

/** `registry.get('EMAIL').send(` — the mailbox transport, named outright. */
const ADAPTER_LITERAL_RE = /\.get\(\s*(['"])EMAIL\1\s*\)\s*\.send\s*\(/g;

/** `registry.get(channelType).send(` — the same thing reached through a variable. */
const ADAPTER_DYNAMIC_RE = /\.get\(\s*(?!['"])[^)\n]{1,80}\)\s*\.send\s*\(/g;

/** `adapter.send(` — the registry lookup parked in a local first. */
const ADAPTER_LOCAL_RE = /\b\w*[Aa]dapter\s*\.send\s*\(/g;

/** nodemailer, reached around both transports entirely. */
const NODEMAILER_RE = /\bcreateTransport\s*\(|from\s+['"]nodemailer['"]/g;

/**
 * Blank out comments, keeping every newline so line numbers stay true. Prose
 * about `sendPlainEmail` is documentation, not a call site — and this file
 * would otherwise punish the comments that explain the seam.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:/\\])\/\/[^\n]*/gm, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

export function findCallSites(files: { rel: string; src: string }[]): CallSite[] {
  const out: CallSite[] = [];
  for (const { rel, src } of files) {
    const code = stripComments(src);
    const at = (index: number) => code.slice(0, index).split('\n').length;
    const snippetAt = (index: number) =>
      src.split('\n')[at(index) - 1]?.trim().slice(0, 120) ?? '';

    for (const m of code.matchAll(EMAIL_SERVICE_RE)) {
      // `this.sendEmail(...)` is the file's own private helper, not a transport.
      if (m[1] === 'this') continue;
      out.push({ rel, line: at(m.index!), surface: 'email-service', snippet: snippetAt(m.index!) });
    }
    for (const re of [ADAPTER_LITERAL_RE, ADAPTER_DYNAMIC_RE, ADAPTER_LOCAL_RE]) {
      for (const m of code.matchAll(re)) {
        out.push({ rel, line: at(m.index!), surface: 'email-adapter', snippet: snippetAt(m.index!) });
      }
    }
    for (const m of code.matchAll(NODEMAILER_RE)) {
      out.push({ rel, line: at(m.index!), surface: 'nodemailer', snippet: snippetAt(m.index!) });
    }
  }
  return out;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/**
 * Nest module files list `EmailService` as a provider. That is DI wiring, not
 * a send, and it has no call sites of its own.
 */
const isModuleFile = (rel: string) => rel.endsWith('.module.ts');

const SOURCES = walkTs(SRC_ROOT)
  .map((full) => ({ rel: path.relative(SRC_ROOT, full).split(path.sep).join('/'), full }))
  .filter(({ rel }) => !isModuleFile(rel))
  .map(({ rel, full }) => ({ rel, src: fs.readFileSync(full, 'utf8') }));

const SITES = findCallSites(SOURCES);
const OUTSIDE_THE_SEAM = SITES.filter((s) => !(s.rel in THE_SEAM));

const describeSite = (s: CallSite) => `${s.rel}:${s.line} [${s.surface}] ${s.snippet}`;

// ── the detector's own tests ─────────────────────────────────────────────────

describe('email send parity — the detector', () => {
  const scan = (src: string) => findCallSites([{ rel: 'new/thing.service.ts', src }]);

  it('catches a new raw sendPlainEmail caller', () => {
    const sites = scan(`
      async notify() {
        await this.email.sendPlainEmail('a@b.test', 'Hi', 'body');
      }
    `);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ surface: 'email-service', line: 3 });
  });

  it('catches the *Result variants and the ICS sender too', () => {
    expect(scan(`await this.mail.sendPlainEmailResult(x);`)).toHaveLength(1);
    expect(scan(`await this.mail.sendCampaignEmailResult(x);`)).toHaveLength(1);
    expect(scan(`await this.mail.sendPlainEmailWithIcs(x);`)).toHaveLength(1);
    expect(scan(`await deps.email.sendEmail({ template: 'x' });`)).toHaveLength(1);
  });

  it('catches an adapter reached by literal, by variable, or through a local', () => {
    expect(scan(`await this.registry.get('EMAIL').send({ to });`)).toHaveLength(1);
    expect(scan(`await this.registry.get(channelType).send({ to });`)).toHaveLength(1);
    // Parked in a local, the lookup and the send are one call site, counted once.
    expect(scan(`const adapter = reg.get(t); await adapter.send({ to });`)).toHaveLength(1);
  });

  it('catches nodemailer used around both transports', () => {
    expect(scan(`import * as nodemailer from 'nodemailer';`)).toHaveLength(1);
    expect(scan(`const t = nodemailer.createTransport({ host });`)).toHaveLength(1);
  });

  it('does not mistake a private this.sendEmail helper for a transport call', () => {
    // Both the campaign sender and the workflow handler have one.
    expect(scan(`if (type === 'send_email') return this.sendEmail(subject, body, ctx);`)).toEqual([]);
  });

  it('does not trip on prose about the seam', () => {
    expect(
      scan(`
        /**
         * Before the gateway this was sendPlainEmail(to, subject, body), whose
         * bare \`true\` could not say why nothing arrived.
         */
        // this.email.sendPlainEmail(to, subject, body) — replaced by the gateway
        await this.outboundMail.send(mail);
      `),
    ).toEqual([]);
  });

  it('reports the line the call is on, not the line the file starts at', () => {
    const src = ['', '', '', 'await this.email.sendPlainEmail(a, b, c);'].join('\n');
    expect(scan(src)[0].line).toBe(4);
  });
});

// ── the fitness test ─────────────────────────────────────────────────────────

describe('email send parity — every send goes through the seam', () => {
  it('has a seam to go through', () => {
    for (const rel of Object.keys(THE_SEAM)) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel))).toBe(true);
    }
    // If the gateway itself stopped touching a transport, the seam has moved
    // and this whole file is measuring the wrong thing.
    expect(
      SITES.some((s) => s.rel === 'modules/marketing/channels/outbound/outbound-mail.service.ts'),
    ).toBe(true);
  });

  it('every raw transport call site is the seam or a written exemption', () => {
    // A red here names the file and line. The fix is almost always to call
    // `OutboundMailService.send({ mailClass, … })` instead and map the
    // MailReceipt onto whatever this caller already returns (PLAN §A7) — never
    // to add an entry below without a reason somebody else can read.
    const offenders = OUTSIDE_THE_SEAM.filter(
      (s) => !(`${s.rel}:${s.surface}` in NOT_ON_THE_GATEWAY),
    ).map(describeSite);

    expect(offenders).toEqual([]);
  });

  it('exemptions are pinned to the number of call sites they were written for', () => {
    const counted = new Map<string, number>();
    for (const s of OUTSIDE_THE_SEAM) {
      const key = `${s.rel}:${s.surface}`;
      if (key in NOT_ON_THE_GATEWAY) counted.set(key, (counted.get(key) ?? 0) + 1);
    }
    for (const [key, exemption] of Object.entries(NOT_ON_THE_GATEWAY)) {
      expect({ key, sites: counted.get(key) ?? 0 }).toEqual({ key, sites: exemption.sites });
    }
  });

  it('every exemption still silences something (no stale entry)', () => {
    const live = new Set(OUTSIDE_THE_SEAM.map((s) => `${s.rel}:${s.surface}`));
    const stale = Object.keys(NOT_ON_THE_GATEWAY).filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  it('every exemption still carries the guarantee it was granted for', () => {
    const broken: string[] = [];
    for (const [key, exemption] of Object.entries(NOT_ON_THE_GATEWAY)) {
      const rel = key.slice(0, key.lastIndexOf(':'));
      const src = SOURCES.find((f) => f.rel === rel)?.src ?? '';
      for (const req of exemption.requires ?? []) {
        if (!req.pattern.test(src)) broken.push(`${rel}: ${req.guarantee}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('nothing outside the gateway calls the mailbox-transport helper', () => {
    // The condition of the WorkspaceMailboxService.send exemption: a caller
    // here would be a send with no gate in front of it.
    const callers = SOURCES.filter(
      (f) =>
        !f.rel.startsWith('modules/marketing/channels/outbound/') &&
        f.rel !== 'modules/marketing/channels/workspace-mailbox.service.ts' &&
        /\b(?:workspaceMailbox|mailbox)\s*\.send\s*\(/.test(stripComments(f.src)),
    ).map((f) => f.rel);
    expect(callers).toEqual([]);
  });

  it('only the two transports build the RFC 8058 header pair', () => {
    // A hand-rolled `List-Unsubscribe` is how a booking confirmation acquires
    // one and starts being filed as a list.
    const builders = SOURCES.filter((f) => /listUnsubscribeHeaders\s*\(/.test(stripComments(f.src)))
      .map((f) => f.rel)
      .sort();
    expect(builders).toEqual([
      'common/services/email.service.ts',
      'common/util/list-unsubscribe.ts',
      'modules/marketing/channels/adapters/email.adapter.ts',
    ]);
  });
});

// ── the matrix ───────────────────────────────────────────────────────────────

/**
 * Every MailClass literal on any line that also names `mailClass:` — which
 * covers a ternary (`mailClass: host ? 'INTERNAL' : 'TRANSACTIONAL'`) as well
 * as a plain key. A class passed through a variable is invisible here; that is
 * a knowing limit, because the gate that matters is the raw-transport scan
 * above and a caller reaching this far is already on the seam.
 */
function mailClassesIn(src: string): Set<MailClass> {
  const found = new Set<MailClass>();
  for (const line of stripComments(src).split('\n')) {
    if (!/\bmailClass\s*:/.test(line)) continue;
    for (const cls of MAIL_CLASSES) {
      if (line.includes(`'${cls}'`)) found.add(cls);
    }
  }
  return found;
}

describe('email send parity — the gate matrix is honoured', () => {
  const callers = SOURCES.map((f) => ({ rel: f.rel, classes: mailClassesIn(f.src) })).filter(
    (f) => f.classes.size > 0,
  );

  it('every gateway caller declares its class in this file', () => {
    // A new caller must say which column of GATE_MATRIX it sends under —
    // that is the whole contract, and it is one word.
    const unregistered = callers
      .map((c) => c.rel)
      .filter((rel) => !(rel in GATEWAY_CALLERS) && !(rel in THE_SEAM))
      .sort();
    expect(unregistered).toEqual([]);
  });

  it('each caller sends exactly the classes it was migrated to send', () => {
    for (const [rel, expected] of Object.entries(GATEWAY_CALLERS)) {
      const actual = callers.find((c) => c.rel === rel);
      expect({ rel, classes: [...(actual?.classes ?? [])].sort() }).toEqual({
        rel,
        classes: [...expected].sort(),
      });
    }
  });

  it('every BULK sender carries an unsubscribe mechanism (the CRITICAL, fail-closed)', () => {
    // BULK without `unsubscribe` is refused at the gate — but a caller that
    // never passes one would ship an automation that can only ever refuse,
    // and the failure would be a silent skip rather than a red test.
    const bulk = callers.filter((c) => c.classes.has('BULK')).map((c) => c.rel);
    expect(bulk.sort()).toEqual(
      Object.entries(GATEWAY_CALLERS)
        .filter(([, classes]) => classes.includes('BULK'))
        .map(([rel]) => rel)
        .sort(),
    );
    for (const rel of bulk) {
      const src = SOURCES.find((f) => f.rel === rel)!.src;
      expect({ rel, unsubscribe: /\bunsubscribe\s*:/.test(stripComments(src)) }).toEqual({
        rel,
        unsubscribe: true,
      });
    }
  });

  it('the kill switches exempt exactly the two classes that must survive a suspension', () => {
    // A suspended workspace's OWN mail stops; ours does not, or the suspension
    // locks the owner out of the product they are trying to pay for.
    const exempt = MAIL_CLASSES.filter(
      (c) => GATE_MATRIX[c].workspaceActive === 'never' && GATE_MATRIX[c].sendingPaused === 'never',
    );
    expect(exempt).toEqual(['AUTH', 'INTERNAL']);
  });

  it('the send window may defer bulk and proactive follow-ups, and nothing else', () => {
    // The one gate that DEFERS rather than refuses. Deferring a password reset
    // or an invoice would make the window cause the outage it exists to
    // prevent, so those columns stay `never` — quiet hours are about
    // automation, not about answering an order.
    expect(Object.fromEntries(MAIL_CLASSES.map((c) => [c, GATE_MATRIX[c].quietHours]))).toEqual({
      AUTH: 'never',
      INTERNAL: 'never',
      TRANSACTIONAL: 'never',
      CONVERSATIONAL: 'proactive',
      BULK: 'always',
    });
  });
});
