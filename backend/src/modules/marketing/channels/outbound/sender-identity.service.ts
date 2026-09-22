import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../prisma/prisma.service';
import { EmailFrom } from '../../../../common/services/email.service';
import { ResolvedChannelConfig } from '../channel-adapter.interface';
import { MailboxCandidate, WorkspaceMailboxService } from '../workspace-mailbox.service';
import { SendingDomainsService } from '../../sending-domains/sending-domains.service';
import { MailClass } from './mail-class';

/** Which transport carries the mail, and under whose name. */
export interface SenderIdentity {
  transport: 'MAILBOX_SMTP' | 'MAILBOX_OAUTH' | 'PLATFORM';
  /** Present on the two mailbox transports — what the adapter sends through. */
  config?: ResolvedChannelConfig;
  fromEmail: string;
  fromName: string;
  /** Platform transport only: where a human reply should land. */
  replyTo?: string;
  /** A verified sending domain's aligned signing key. */
  dkim?: { domainName: string; keySelector: string; privateKey: string };
  /** The mail still goes out — this is what the tenant could fix so the NEXT
   *  one goes out better. Never a reason to refuse a send. */
  degraded?: { code: DegradedCode; fix: DegradedFix };
}

export type DegradedCode =
  /** The workspace has no mailbox at all; mail leaves on the platform's. */
  | 'NO_MAILBOX'
  /** A mailbox is configured but its login was never proven. */
  | 'MAILBOX_UNVERIFIED'
  /** The only mailbox is consent-connected, which cannot carry this mail. */
  | 'MAILBOX_SEND_ONLY'
  /** The consent token is gone and the owner has to reconnect. */
  | 'OAUTH_REAUTH'
  /** HTML mail cannot ride the consent transport, so it took the platform's. */
  | 'HTML_ON_CONSENT';

export type DegradedFix =
  | 'CONNECT_MAILBOX'
  | 'VERIFY_MAILBOX'
  | 'RECONNECT_MAILBOX'
  | 'ADD_IMAP';

/** The reply ladder is per workspace and barely changes; a campaign asks it
 *  once per recipient. One minute is long enough to make that free and short
 *  enough that connecting a mailbox shows up while the operator is still
 *  looking at the screen. */
const REPLY_CACHE_MS = 60_000;

/**
 * Does the consent (OAuth) transport carry a real HTML part?
 *
 * `email-oauth.sender.ts` builds a `multipart/alternative` body and Graph sends
 * `contentType: 'HTML'`, so it does. Kept as ONE named answer because the
 * fallback below depends on it: if that transport ever goes back to text-only,
 * flipping this sends HTML mail out through the platform instead of letting it
 * arrive stripped.
 */
const CONSENT_TRANSPORT_SENDS_HTML = true;

/**
 * "Who is this mail from" — asked once, answered once.
 *
 * It used to be answered at each call site, and each one got a different part
 * of it wrong. Platform-fallback mail went out as plain
 * `"Jeeta" <admin@jeetagrowth.com>` with no Reply-To, so a customer answering a
 * quote reached the operator's inbox and never the tenant
 * (`platform-fallback-no-reply-to`) — and the operator ended up holding other
 * tenants' customer PII. Tenant-authored copy left under the platform's own
 * name with nothing saying who wrote it (`tenant-content-platform`). A
 * consent-connected mailbox was offered first in the UI and then excluded from
 * every send (`oauth-send-only`).
 *
 * THE FROM ADDRESS ON THE PLATFORM TRANSPORT NEVER CHANGES. `jeetagrowth.com`
 * is DMARC `p=reject` with SPF `-all` and no tenant DKIM key: swapping the From
 * for the tenant's address fails alignment at the recipient and loses the mail
 * outright. Only the display name and the Reply-To may change — which is why
 * the one place that may legitimately send from a tenant address (rung 4) is
 * the one that also carries that domain's own DKIM key.
 */
@Injectable()
export class SenderIdentityService {
  private readonly replyCache = new Map<string, { at: number; value: ReplyIdentity }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailbox: WorkspaceMailboxService,
    private readonly sendingDomains: SendingDomainsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The ladder, short-circuiting. Each rung is a better identity than the one
   * below it, and the bottom one always answers — a missing reply address
   * degrades the mail, it never refuses it.
   */
  async resolve(
    workspaceId: string,
    mailClass: MailClass,
    opts?: { html?: boolean },
  ): Promise<SenderIdentity> {
    // 1. Ours, about us. A tenant Reply-To on a password reset is the phishing
    //    shape itself, and "Acme via Jeeta" on a login code relabels our own
    //    security mail as the tenant's. No tenant read at all: account recovery
    //    must not depend on one succeeding.
    if (mailClass === 'AUTH' || mailClass === 'INTERNAL') {
      return {
        transport: 'PLATFORM',
        fromEmail: this.platformFrom(),
        fromName: this.platformName(),
      };
    }

    // 2. The workspace's own, proven SMTP mailbox. Unchanged semantics — the
    //    campaign sender asks the same question the same way.
    const smtp = await this.mailbox.resolve(workspaceId);
    if (smtp) {
      const base = await this.replyBase(workspaceId);
      return {
        transport: 'MAILBOX_SMTP',
        config: smtp,
        fromEmail: this.mailboxAddress(smtp),
        fromName: base.name,
      };
    }

    // 3. A consent-connected mailbox, for everything except bulk. Bulk is
    //    excluded because the OAuth branch of the adapter carries no
    //    `List-Unsubscribe`, and RFC 8058 headers are fail-closed on bulk.
    const candidates = await this.mailbox.candidates(workspaceId);
    let htmlFellThrough = false;
    if (mailClass !== 'BULK') {
      const consent = candidates.find((c) => c.kind === 'CONSENT' && c.usable);
      if (consent) {
        if (opts?.html && !this.consentCarriesHtml()) {
          // Better a formatted mail from our address than a stripped one from
          // theirs: the body is what the customer actually reads.
          htmlFellThrough = true;
        } else {
          return {
            transport: 'MAILBOX_OAUTH',
            config: consent.config,
            fromEmail: consent.address ?? this.platformFrom(),
            fromName: (await this.replyBase(workspaceId, candidates)).name,
            // It sends, it cannot receive — and the tenant should hear that
            // from us rather than from a customer whose reply went unanswered.
            ...(consent.canReceive
              ? {}
              : { degraded: { code: 'MAILBOX_SEND_ONLY' as const, fix: 'ADD_IMAP' as const } }),
          };
        }
      }
    }

    const base = await this.replyBase(workspaceId, candidates);
    const degraded = this.degradedFor(candidates, mailClass, htmlFellThrough);

    // 4. A verified sending domain: the ONE From-swap that is safe, because it
    //    ships with the aligned DKIM key that authenticates it. Inert until an
    //    ESP transport is configured.
    if (mailClass === 'TRANSACTIONAL' || mailClass === 'BULK') {
      const from: EmailFrom | null = await this.sendingDomains.resolveFrom(workspaceId);
      if (from?.email) {
        return {
          transport: 'PLATFORM',
          fromEmail: from.email,
          // The domain is the tenant's own, so the mail needs no "via" — it is
          // already visibly theirs.
          fromName: from.name?.trim() || base.name,
          ...(from.dkim ? { dkim: from.dkim } : {}),
          ...(base.replyTo ? { replyTo: base.replyTo } : {}),
          ...(degraded ? { degraded } : {}),
        };
      }
    }

    // 5. The platform transport, saying whose mail it is carrying.
    return {
      transport: 'PLATFORM',
      fromEmail: this.platformFrom(),
      fromName: `${base.name} via ${this.platformName()}`,
      ...(base.replyTo ? { replyTo: base.replyTo } : {}),
      ...(degraded ? { degraded } : {}),
    };
  }

  /**
   * Where a reply goes and whose name is on the mail — the half of the identity
   * that does not depend on which transport carries it.
   */
  async replyIdentity(workspaceId: string): Promise<ReplyIdentity> {
    return this.replyBase(workspaceId);
  }

  // ---- the reply ladder ----

  private async replyBase(
    workspaceId: string,
    known?: MailboxCandidate[],
  ): Promise<ReplyIdentity> {
    const hit = this.replyCache.get(workspaceId);
    if (hit && Date.now() - hit.at < REPLY_CACHE_MS) return hit.value;

    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true, settings: true },
    });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;

    const name =
      str(settings.emailFromName) ??
      (await this.brandName(workspaceId)) ??
      ws?.name?.trim() ??
      this.platformName();

    // (a) The workspace's own mailbox address. A consent mailbox counts here
    //     even though it cannot carry every send: Reply-To needs an ADDRESS,
    //     not the ability to send, and that mailbox is where the tenant reads.
    const candidates = known ?? (await this.mailbox.candidates(workspaceId));
    const mailboxAddress = candidates.find((c) => c.address)?.address ?? undefined;

    // (b) Whatever the workspace configured, then (c) the OWNER.
    const replyTo =
      mailboxAddress ?? str(settings.replyTo) ?? (await this.ownerEmail(workspaceId));

    const value: ReplyIdentity = { name, ...(replyTo ? { replyTo } : {}) };
    this.replyCache.set(workspaceId, { at: Date.now(), value });
    return value;
  }

  private async brandName(workspaceId: string): Promise<string | undefined> {
    const brand = await this.prisma.brandProfile.findUnique({
      where: { workspaceId },
      select: { brandName: true },
    });
    return str(brand?.brandName);
  }

  /**
   * The OWNER, resolved through the MEMBERSHIP — never `MarketingUser.
   * workspaceId`, which is the user's HOME workspace. An owner whose home is
   * elsewhere owns this one just as much, and reading the pointer instead would
   * silently drop them and leave the workspace with no reply address at all.
   */
  private async ownerEmail(workspaceId: string): Promise<string | undefined> {
    const m = await this.prisma.workspaceMembership.findFirst({
      where: { workspaceId, role: 'OWNER', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { user: { select: { email: true } } },
    });
    return str(m?.user?.email);
  }

  // ---- what the tenant could fix ----

  private degradedFor(
    candidates: MailboxCandidate[],
    mailClass: MailClass,
    htmlFellThrough: boolean,
  ): SenderIdentity['degraded'] {
    if (htmlFellThrough) return { code: 'HTML_ON_CONSENT', fix: 'CONNECT_MAILBOX' };
    if (!candidates.length) return { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' };
    if (candidates.some((c) => c.kind === 'CONSENT' && c.needsReauth)) {
      return { code: 'OAUTH_REAUTH', fix: 'RECONNECT_MAILBOX' };
    }
    if (candidates.some((c) => c.kind === 'SMTP' && c.usable && !c.verified)) {
      return { code: 'MAILBOX_UNVERIFIED', fix: 'VERIFY_MAILBOX' };
    }
    if (mailClass === 'BULK' && candidates.some((c) => c.kind === 'CONSENT' && c.usable)) {
      // It can send, just not a mailing list — and the fix is a second mailbox,
      // not a reconnect of this one.
      return { code: 'MAILBOX_SEND_ONLY', fix: 'CONNECT_MAILBOX' };
    }
    return { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' };
  }

  // ---- the platform's own identity ----

  /** Mirrors `EmailService.fromHeader`, so typing a mail does not move it. */
  private platformFrom(): string {
    return (
      this.config.get<string>('EMAIL_FROM') || this.config.get<string>('EMAIL_USER') || ''
    );
  }

  private platformName(): string {
    return (
      this.config.get<string>('EMAIL_FROM_NAME') ||
      this.config.get<string>('APP_NAME') ||
      'Marketing'
    );
  }

  private mailboxAddress(config: ResolvedChannelConfig): string {
    const s = config.secrets ?? {};
    return (s.fromEmail || s.smtpUser || config.externalId || '').trim().toLowerCase();
  }

  /** Overridable in tests; see `CONSENT_TRANSPORT_SENDS_HTML`. */
  private consentCarriesHtml(): boolean {
    return CONSENT_TRANSPORT_SENDS_HTML;
  }
}

export interface ReplyIdentity {
  name: string;
  replyTo?: string;
}

/** A trimmed non-empty string, or nothing — `''` is not an answer. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
