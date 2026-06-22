import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";
import * as fsp from "fs/promises";
import * as path from "path";
import * as Handlebars from "handlebars";
import { maskEmail } from "../helpers/pii-mask.helper";
import { withTimeout } from "../util/with-timeout";

// Register Handlebars helpers
Handlebars.registerHelper("currentYear", () => new Date().getFullYear());

export interface EmailOptions {
  to: string;
  subject: string;
  template: string;
  context: Record<string, any>;
}

/** A per-workspace sender identity (Epic 13 sending domains). When omitted, the
 *  platform default From (EMAIL_FROM/EMAIL_USER + EMAIL_FROM_NAME) is used. */
export interface EmailFrom {
  email: string;
  name?: string;
}

@Injectable()
export class EmailService {
  private transporter: Transporter;
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
    const port = this.configService.get<number>("EMAIL_PORT");
    const user = this.configService.get<string>("EMAIL_USER");
    const pass = this.configService.get<string>("EMAIL_PASSWORD");

    if (!host || !user || !pass) {
      this.logger.warn(
        "Email configuration missing. Emails will be logged instead of sent.",
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for other ports
      auth: {
        user,
        pass,
      },
      // Bound every phase of the SMTP exchange so a stalled server can't hang
      // the awaiting caller (auth bursts + cron mailings sit on this path).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
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
   * Send email using template
   */
  async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      const { to, subject, template, context } = options;

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
  ): Promise<boolean> {
    try {
      if (!this.transporter) {
        this.logger.log(`[EMAIL MOCK] To: ${maskEmail(to)} (html=${html ? html.length : 0} chars)`);
        return true;
      }
      await withTimeout(
        this.transporter.sendMail({
          from: this.fromHeader(fromOverride),
          to,
          subject,
          text,
          ...(html ? { html } : {}),
        }),
        25_000,
        `sendMail to ${maskEmail(to)}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send campaign email to ${maskEmail(to)}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  /**
   * Send a short plain-text email without a Handlebars template.
   * Use only for transactional system notices (status changes, etc.) where
   * a bespoke template would be overkill.
   */
  async sendPlainEmail(
    to: string,
    subject: string,
    body: string,
    fromOverride?: EmailFrom,
  ): Promise<boolean> {
    try {
      if (!this.transporter) {
        // v2.8.97 — same masking as sendEmail above. Body length is
        // logged in place of the body so ops can sanity-check "the
        // message wasn't truncated" without exposing OTP/token text.
        this.logger.log(`[EMAIL MOCK] To: ${maskEmail(to)}`);
        this.logger.log(`[EMAIL MOCK] Subject: ${subject}`);
        this.logger.log(`[EMAIL MOCK] Body length: ${body.length} chars`);
        return true;
      }
      await withTimeout(
        this.transporter.sendMail({
          from: this.fromHeader(fromOverride),
          to,
          subject,
          text: body,
        }),
        25_000,
        `sendMail to ${maskEmail(to)}`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send plain email to ${maskEmail(to)}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
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
