import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";
import * as fsp from "fs/promises";
import * as path from "path";
import * as Handlebars from "handlebars";
import { maskEmail } from "../helpers/pii-mask.helper";
import { withTimeout } from "../util/with-timeout";
import { listUnsubscribeHeaders } from "../util/list-unsubscribe";
import { isSingleAddress } from "../util/email-address";

// Register Handlebars helpers
Handlebars.registerHelper("currentYear", () => new Date().getFullYear());

/**
 * The RFC 4871 §5.5 field list nodemailer signs by default
 * (`lib/dkim/sign.js`), plus `List-Unsubscribe-Post`. Nodemailer signs
 * `List-Unsubscribe` but not its `-Post` sibling, and Gmail and Yahoo refuse
 * one-click unsubscribe unless BOTH are covered by the signature — so without
 * this override the RFC 8058 headers this service already emits stay inert.
 */
export const DKIM_HEADER_FIELD_NAMES =
  "From:Sender:Reply-To:Subject:Date:Message-ID:To:" +
  "Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:" +
  "Content-Description:Resent-Date:Resent-From:Resent-Sender:" +
  "Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:" +
  "List-Id:List-Help:List-Unsubscribe:List-Subscribe:List-Post:" +
  "List-Owner:List-Archive:List-Unsubscribe-Post";

/** What the single-recipient guard writes as the failure reason. */
const NOT_SINGLE_ADDRESS = "recipient address is not a single valid address";

export interface EmailOptions {
  to: string;
  subject: string;
  template: string;
  context: Record<string, any>;
}

/** A per-workspace sender identity (Epic 13 sending domains). When omitted, the
 *  platform default From (EMAIL_FROM/EMAIL_USER + EMAIL_FROM_NAME) is used. The
 *  optional dkim signs the message with the workspace's verified-domain key so
 *  the From-swap is authenticated (DKIM alignment) instead of hurting deliverability. */
export interface EmailFrom {
  email: string;
  name?: string;
  /** Where a reply goes. The From address is fixed by DMARC alignment, so this
   *  is the only way a tenant's mail comes back to the tenant. */
  replyTo?: string;
  dkim?: {
    domainName: string;
    keySelector: string;
    privateKey: string;
    headerFieldNames?: string;
  };
}

/** How the attached invite is meant to be read. A cancellation sent as a
 *  REQUEST re-adds the appointment the customer just cancelled. */
export interface IcsOptions {
  method?: "REQUEST" | "CANCEL";
  filename?: string;
}

/**
 * What one send actually did.
 *
 * The boolean senders keep their signatures because four call sites branch on
 * truthiness (`.then(ok => { if (!ok) … })`, `delivered ? 'sent' : 'NOT sent'`)
 * and an object is always truthy — TypeScript flags neither. The `*Result`
 * names exist so that migration is compiler-checked, one caller at a time
 * (`send-error-race`).
 */
export interface MailSendResult {
  ok: boolean;
  /** The provider's own words, truncated — never a paraphrase. */
  error?: string;
  messageId?: string | null;
  /** The 3-digit SMTP status, when nodemailer reported one. */
  smtpCode?: number;
}

@Injectable()
export class EmailService {
  private transporter: Transporter;
  /** Reason the last plain/campaign send threw — see consumeLastPlainSendError. */
  private lastPlainSendError: string | null = null;
  private readonly logger = new Logger(EmailService.name);
  private readonly templatesPath: string;
  // Iter-98: cache compiled handlebars templates for the process
  // lifetime. Same reasoning as iter-97 (NotificationService): pre-fix
  // every sendEmail call re-read the .hbs from disk (sync, blocking the
  // event loop) and re-ran Handlebars.compile. EmailService sits on the
  // hot path for cron z-report mailings and auth verification bursts.
  // Misses are NOT cached — compileTemplate throws on a missing
  // template (auth needs to surface that loudly); we don't want a
  // failure entry to outlive the missing-file condition.
  private readonly templateCache = new Map<
    string,
    HandlebarsTemplateDelegate
  >();

  constructor(private configService: ConfigService) {
    // Use process.cwd() instead of __dirname for bundled production builds
    this.templatesPath = path.join(process.cwd(), "templates/emails");
    this.initializeTransporter();
  }

  private initializeTransporter() {
    const host = this.configService.get<string>("EMAIL_HOST");
    // Env values arrive as strings, so the old `port === 465` was never true
    // and switching the deploy to implicit TLS would have timed out every
    // send. NaN falls back to 587, nodemailer's own default (email-port-string).
    const port = Number(this.configService.get("EMAIL_PORT")) || 587;
    const user = this.configService.get<string>("EMAIL_USER");
    const pass = this.configService.get<string>("EMAIL_PASSWORD");

    if (!host || !user || !pass) {
      this.logger.warn(
        "Email configuration missing. Emails will be logged instead of sent.",
      );
      return;
    }

    // Implicit TLS follows the port unless EMAIL_SECURE says otherwise, for
    // providers that run implicit TLS on a non-standard port.
    const secureRaw = this.configService.get("EMAIL_SECURE");
    const secure =
      secureRaw === undefined || secureRaw === null || secureRaw === ""
        ? port === 465
        : String(secureRaw).toLowerCase() === "true";

    const dkim = this.platformDkim();

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      // Bound every phase of the SMTP exchange so a stalled server can't hang
      // the awaiting caller (auth bursts + cron mailings sit on this path).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      // Signing at the TRANSPORT covers sendEmail too — the path that carries
      // verification, reset and temp-password mail, which takes no per-message
      // override. A per-message tenant key still wins over this one
      // (nodemailer/lib/mailer/index.js:208), which is what alignment needs.
      ...(dkim ? { dkim } : {}),
    });

    // Verify connection
    this.transporter.verify((error) => {
      if (error) {
        this.logger.error("Email transporter verification failed:", error);
      } else {
        this.logger.log("Email transporter is ready to send emails");
      }
    });
  }

  /**
   * The platform's own DKIM key, or null.
   *
   * Both halves must be present or nothing is built: a half-configured deploy
   * must stay byte-identical to an unsigned one. The domain defaults to the
   * From domain because a signature whose `d=` does not align with From buys
   * nothing under DMARC (`no-dkim`).
   */
  private platformDkim(): {
    domainName: string;
    keySelector: string;
    privateKey: string;
    headerFieldNames: string;
  } | null {
    const keySelector = (
      this.configService.get<string>("EMAIL_DKIM_SELECTOR") || ""
    ).trim();
    const privateKey = this.dkimPrivateKey();
    if (!keySelector || !privateKey) return null;

    const fromAddress =
      this.configService.get<string>("EMAIL_FROM") ||
      this.configService.get<string>("EMAIL_USER") ||
      "";
    const domainName =
      (this.configService.get<string>("EMAIL_DKIM_DOMAIN") || "").trim() ||
      fromAddress.split("@")[1]?.trim() ||
      "";
    if (!domainName) return null;

    return {
      domainName,
      keySelector,
      privateKey,
      headerFieldNames: DKIM_HEADER_FIELD_NAMES,
    };
  }

  /**
   * The PEM, however the deploy shipped it.
   *
   * The key is multi-line and the deploy writes .env with echo/printf, so it
   * travels base64 (EMAIL_DKIM_PRIVATE_KEY_B64) exactly as EMAIL_PASSWORD_B64
   * already does. A value that does not decode to a PEM is REFUSED rather than
   * used: every message signed with a broken key is measurably worse than an
   * unsigned one.
   */
  private dkimPrivateKey(): string | null {
    const b64 = (
      this.configService.get<string>("EMAIL_DKIM_PRIVATE_KEY_B64") || ""
    ).trim();
    const raw = (
      this.configService.get<string>("EMAIL_DKIM_PRIVATE_KEY") || ""
    ).trim();

    let candidate = "";
    if (b64) {
      candidate = b64.includes("BEGIN")
        ? b64
        : Buffer.from(b64, "base64").toString("utf8");
    } else {
      candidate = raw;
    }
    if (!candidate) return null;

    // A .env round-trip turns real newlines into the two characters \n.
    candidate = candidate.replace(/\\n/g, "\n").trim();
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(candidate)) {
      this.logger.warn(
        "EMAIL_DKIM key is not a PEM private key — sending unsigned rather than with a broken signature.",
      );
      return null;
    }
    return candidate;
  }

  /**
   * Exactly one recipient, at the platform transport.
   *
   * `info@x.com; satis@x.com` used to go out as one message to two people —
   * one unsubscribe token covering both — and a CR/LF in the value let the
   * recipient field write its own headers. Returns false rather than throwing:
   * every caller here already treats false as handled.
   *
   * The breadcrumb matters as much as the refusal. `campaign-sender` writes
   * `consumeLastPlainSendError()` onto EVERY recipient row, so a bare false
   * gives the tenant hundreds of blank reasons (`single-recipient-check`).
   * The value itself is never logged — a log line is a place an attacker would
   * like their text to appear.
   */
  private guardRecipient(to: string, label: string): boolean {
    if (isSingleAddress(to)) return true;
    this.lastPlainSendError = NOT_SINGLE_ADDRESS;
    this.logger.warn(`Refusing ${label}: ${NOT_SINGLE_ADDRESS}`);
    return false;
  }

  /**
   * The one body the three tenant-facing senders share.
   *
   * Mock-mode behaviour is deliberately unchanged (`{ ok: true }`, the same
   * [EMAIL MOCK] lines): `isConfigured()` is how a caller asks whether a
   * message can really leave the building, and moving that decision in here
   * would break dev, CI and every inert deploy.
   */
  private async deliver(args: {
    /** Used in the failure log line: "Failed to send <label> to …". */
    label: string;
    to: string;
    subject: string;
    /** Built only when there is no transporter — a production send should not
     *  pay to format log lines it will never print. */
    mockLines: () => string[];
    /** The body parts — text/html/icalEvent — of the nodemailer payload. */
    message: Record<string, any>;
    fromOverride?: EmailFrom;
    listUnsubscribeUrl?: string;
    /**
     * The caller's own Message-ID, bracketed. The outbound gateway mints a
     * deterministic one, stores it on the ledger row and matches bounces and
     * Sent-folder copies against it — which only works if it is the id that
     * actually goes out. Absent, nodemailer mints its own, as it always has.
     */
    messageId?: string;
  }): Promise<MailSendResult> {
    const { label, to, subject, fromOverride } = args;
    if (!this.guardRecipient(to, label)) {
      return { ok: false, error: NOT_SINGLE_ADDRESS };
    }
    if (!this.transporter) {
      for (const line of args.mockLines()) this.logger.log(line);
      return { ok: true };
    }
    const unsubHeaders = listUnsubscribeHeaders(args.listUnsubscribeUrl);
    try {
      const info = await withTimeout(
        this.transporter.sendMail({
          from: this.fromHeader(fromOverride),
          to,
          subject,
          ...args.message,
          ...(args.messageId ? { messageId: args.messageId } : {}),
          ...(fromOverride?.replyTo ? { replyTo: fromOverride.replyTo } : {}),
          // The tenant key gets the same signed-header list as the platform
          // one, or the ESP path ships with the identical one-click hole.
          ...(fromOverride?.dkim
            ? {
                dkim: {
                  headerFieldNames: DKIM_HEADER_FIELD_NAMES,
                  ...fromOverride.dkim,
                },
              }
            : {}),
          ...(Object.keys(unsubHeaders).length ? { headers: unsubHeaders } : {}),
        }),
        25_000,
        `sendMail to ${maskEmail(to)}`,
      );
      return { ok: true, messageId: (info as any)?.messageId ?? null };
    } catch (error) {
      this.logger.error(
        `Failed to send ${label} to ${maskEmail(to)}`,
        error instanceof Error ? error.stack : String(error),
      );
      const message = error instanceof Error ? error.message : String(error);
      // The singleton breadcrumb stays until the last caller has moved to the
      // *Result names; the reason now also travels with its own send.
      this.lastPlainSendError = message;
      const code = (error as any)?.responseCode;
      return {
        ok: false,
        error: message.slice(0, 300),
        ...(Number.isFinite(code) ? { smtpCode: Number(code) } : {}),
      };
    }
  }

  /**
   * Send email using template
   */
  async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      const { to, subject, template, context } = options;
      if (!this.guardRecipient(to, "email")) return false;

      // Compile template
      const html = await this.compileTemplate(template, context);

      // If no transporter (missing config), just log
      if (!this.transporter) {
        // v2.8.97 — mock-mode logging now masks the recipient AND
        // drops the raw context object. Pre-fix the [EMAIL MOCK]
        // stream re-exposed PII the production path is careful to
        // mask: full recipient addresses, OTP codes / reset tokens
        // / temp passwords embedded in template contexts, and full
        // email bodies after compile. The mock branch fires when
        // EMAIL_USER/EMAIL_PASSWORD are absent, which is the typical
        // staging / CI shape — so the leak surface was real even
        // though the path "felt" dev-only.
        this.logger.log(`[EMAIL MOCK] To: ${maskEmail(to)}`);
        this.logger.log(`[EMAIL MOCK] Subject: ${subject}`);
        this.logger.log(`[EMAIL MOCK] Template: ${template}`);
        this.logger.log(
          `[EMAIL MOCK] Context keys: ${Object.keys(context).join(", ")}`,
        );
        return true;
      }

      const from =
        this.configService.get<string>("EMAIL_FROM") ||
        this.configService.get<string>("EMAIL_USER");

      // Send email (app-level timeout backstops nodemailer's socket timeouts).
      const info = await withTimeout(
        this.transporter.sendMail({
          from: `"${this.configService.get<string>("EMAIL_FROM_NAME") || this.configService.get<string>("APP_NAME") || "Marketing"}" <${from}>`,
          to,
          subject,
          html,
        }),
        25_000,
        `sendMail to ${maskEmail(to)}`,
      );

      // PII: mask recipient in the structured log stream — message id is
      // the actual debugging hook, not the full address (see iter-30
      // commit message + pii-mask.helper.ts for context).
      this.logger.log(
        `Email sent successfully to ${maskEmail(to)}. Message ID: ${info.messageId}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${maskEmail(options.to)}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  /**
   * Campaign email with an optional HTML part (GHL email block builder). Sends a
   * multipart message: `text` is the plain-text fallback, `html` (when present)
   * is what clients render. Mirrors sendPlainEmail's mock + masking + timeout.
   */
  /** Build the RFC-5322 From header — a per-workspace override when supplied,
   *  otherwise the platform default. Centralised so every send path is consistent. */
  private fromHeader(fromOverride?: EmailFrom): string {
    const email =
      fromOverride?.email ||
      this.configService.get<string>("EMAIL_FROM") ||
      this.configService.get<string>("EMAIL_USER");
    const name =
      fromOverride?.name ||
      this.configService.get<string>("EMAIL_FROM_NAME") ||
      this.configService.get<string>("APP_NAME") ||
      "Marketing";
    return `"${name}" <${email}>`;
  }

  async sendCampaignEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
    fromOverride?: EmailFrom,
    /** Set for BULK mail only — becomes the RFC 8058 unsubscribe headers. */
    listUnsubscribeUrl?: string,
  ): Promise<boolean> {
    const r = await this.sendCampaignEmailResult(
      to,
      subject,
      text,
      html,
      fromOverride,
      listUnsubscribeUrl,
    );
    return r.ok;
  }

  /** `sendCampaignEmail`, with the reason the send failed attached to it. */
  async sendCampaignEmailResult(
    to: string,
    subject: string,
    text: string,
    html?: string,
    fromOverride?: EmailFrom,
    listUnsubscribeUrl?: string,
    messageId?: string,
  ): Promise<MailSendResult> {
    return this.deliver({
      label: "campaign email",
      to,
      subject,
      mockLines: () => [
        `[EMAIL MOCK] To: ${maskEmail(to)} (html=${html ? html.length : 0} chars)`,
      ],
      message: { text, ...(html ? { html } : {}) },
      fromOverride,
      listUnsubscribeUrl,
      messageId,
    });
  }

  /**
   * Send a short plain-text email without a Handlebars template.
   * Use only for transactional system notices (status changes, etc.) where
   * a bespoke template would be overkill.
   */
  /**
   * Is there a real mailer behind this service?
   *
   * `sendPlainEmail` deliberately returns TRUE with no transporter — it logs an
   * [EMAIL MOCK] line and reports success, which is right for dev and inert
   * deploys (the inert-feature rule) and wrong for anything that needs to know
   * whether a message actually left the building. A caller that must not claim
   * a delivery it cannot make asks this first.
   */
  isConfigured(): boolean {
    return !!this.transporter;
  }

  async sendPlainEmail(
    to: string,
    subject: string,
    body: string,
    fromOverride?: EmailFrom,
    /** Set for BULK mail only — becomes the RFC 8058 unsubscribe headers. A
     *  transactional notice (password reset, status change) passes nothing, so
     *  no client is ever invited to "unsubscribe" from one. */
    listUnsubscribeUrl?: string,
  ): Promise<boolean> {
    const r = await this.sendPlainEmailResult(
      to,
      subject,
      body,
      fromOverride,
      listUnsubscribeUrl,
    );
    return r.ok;
  }

  /** `sendPlainEmail`, with the reason the send failed attached to it. */
  async sendPlainEmailResult(
    to: string,
    subject: string,
    body: string,
    fromOverride?: EmailFrom,
    listUnsubscribeUrl?: string,
    messageId?: string,
  ): Promise<MailSendResult> {
    return this.deliver({
      label: "plain email",
      to,
      subject,
      // v2.8.97 — same masking as sendEmail above. Body length is logged in
      // place of the body so ops can sanity-check "the message wasn't
      // truncated" without exposing OTP/token text.
      mockLines: () => [
        `[EMAIL MOCK] To: ${maskEmail(to)}`,
        `[EMAIL MOCK] Subject: ${subject}`,
        `[EMAIL MOCK] Body length: ${body.length} chars`,
      ],
      message: { text: body },
      fromOverride,
      listUnsubscribeUrl,
      messageId,
    });
  }

  /**
   * Can this deployment send email AT ALL, right now?
   *
   * The transporter is verified once at boot and the result goes to the logger,
   * so the answer exists for a moment and is then unreachable. That left one
   * way to find out whether mail works: wait for something to try to send.
   * Live, that meant waiting for the 07:00 brief — which failed, and could not
   * announce its own failure by email.
   *
   * Same shape as a channel health check: a live probe, no message sent, and
   * the provider's own words on failure rather than a boolean.
   */
  /**
   * `verify()` opens a connection and AUTHENTICATES. Every call is a real login
   * attempt at the provider, and this is reachable from a READ tool that needs
   * no approval — so an agent asking "is mail working?" in a loop is an agent
   * hammering the mailbox with logins, which is how a healthy mailbox starts
   * answering 535.
   *
   * Whether that is what happened here is not proven; what IS observed is the
   * same tool returning ok:true and 535 on back-to-back calls, which makes the
   * signal useless either way — an intermittent answer cannot tell you whether
   * mail works. A short cache fixes both halves: the provider sees at most one
   * login a minute, and repeated asks get one stable answer instead of a coin
   * flip.
   *
   * `checkedAt` and `cached` are returned so the caller can see it is being
   * given a recent answer rather than a fresh handshake — a cache that hides
   * its own staleness is the failure this codebase keeps finding.
   */
  private lastVerify: { at: number; result: { ok: boolean; configured: boolean; error?: string } } | null = null;

  async verifyTransport(
    maxAgeMs = 60_000,
    now: () => number = Date.now,
  ): Promise<{ ok: boolean; configured: boolean; error?: string; checkedAt: string; cached: boolean }> {
    if (!this.transporter) {
      return { ok: false, configured: false, checkedAt: new Date(now()).toISOString(), cached: false };
    }
    const at = now();
    if (this.lastVerify && at - this.lastVerify.at < maxAgeMs) {
      return { ...this.lastVerify.result, checkedAt: new Date(this.lastVerify.at).toISOString(), cached: true };
    }
    let result: { ok: boolean; configured: boolean; error?: string };
    try {
      await this.transporter.verify();
      result = { ok: true, configured: true };
    } catch (e) {
      result = {
        ok: false,
        configured: true,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      };
    }
    this.lastVerify = { at, result };
    return { ...result, checkedAt: new Date(at).toISOString(), cached: false };
  }

  /**
   * Why the most recent sendPlainEmail failed, if one did.
   *
   * The SMTP error is caught inside sendPlainEmail and written only to the
   * logger, so a caller that needs to REPORT the failure — the daily brief,
   * which cannot announce its own non-delivery by email — had nothing but a
   * false. Live, that produced "digest undelivered for 1 recipient" with no
   * indication whether the mailbox rejected us, the password is wrong, or the
   * host was unreachable.
   *
   * Cleared by `consume`: the reason belongs to one failure, and a stale one
   * attached to a later, unrelated failure would be worse than none.
   */
  consumeLastPlainSendError(): string | null {
    const e = this.lastPlainSendError;
    this.lastPlainSendError = null;
    return e ? e.slice(0, 300) : null;
  }

  /**
   * Send a plain-text transactional email with an attached iCalendar invite
   * (`.ics`). Used by booking confirmations so the recipient can one-click add
   * the appointment (with its Meet/Teams join link) to their calendar. Same
   * mock/timeout behaviour as sendPlainEmail; best-effort (returns false on
   * failure rather than throwing).
   */
  async sendPlainEmailWithIcs(
    to: string,
    subject: string,
    body: string,
    ics: string,
    fromOverride?: EmailFrom,
    ical?: IcsOptions,
  ): Promise<boolean> {
    const r = await this.sendPlainEmailWithIcsResult(
      to,
      subject,
      body,
      ics,
      fromOverride,
      ical,
    );
    return r.ok;
  }

  /** `sendPlainEmailWithIcs`, with the reason the send failed attached to it. */
  async sendPlainEmailWithIcsResult(
    to: string,
    subject: string,
    body: string,
    ics: string,
    fromOverride?: EmailFrom,
    ical?: IcsOptions,
    messageId?: string,
  ): Promise<MailSendResult> {
    return this.deliver({
      label: "ics email",
      to,
      subject,
      mockLines: () => [
        `[EMAIL MOCK] To: ${maskEmail(to)}`,
        `[EMAIL MOCK] Subject: ${subject}`,
        `[EMAIL MOCK] Body length: ${body.length} chars, ics: ${ics.length} chars`,
      ],
      message: {
        text: body,
        icalEvent: {
          method: ical?.method ?? "REQUEST",
          filename: ical?.filename ?? "invite.ics",
          content: ics,
        },
      },
      fromOverride,
      messageId,
    });
  }

  /**
   * Compile Handlebars template. Iter-98: first call per templateName
   * compiles + caches; subsequent calls skip the disk read and the
   * compile. Misses still throw — auth flows depend on the loud error.
   */
  private async compileTemplate(
    templateName: string,
    context: Record<string, any>,
  ): Promise<string> {
    try {
      const template = await this.loadTemplate(templateName);
      return template(context);
    } catch (error) {
      this.logger.error(`Failed to compile template ${templateName}:`, error);
      throw new Error(`Email template ${templateName} not found or invalid`);
    }
  }

  private async loadTemplate(
    templateName: string,
  ): Promise<HandlebarsTemplateDelegate> {
    const cached = this.templateCache.get(templateName);
    if (cached) return cached;
    const templatePath = path.join(this.templatesPath, `${templateName}.hbs`);
    const source = await fsp.readFile(templatePath, "utf-8");
    const compiled = Handlebars.compile(source);
    this.templateCache.set(templateName, compiled);
    return compiled;
  }

}
