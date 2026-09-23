import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import {
  canSignTriggerLinkContact,
  signTriggerLinkContact,
  verifyTriggerLinkContact,
} from './trigger-link-contact.token';

const HTTP_URL = /^https?:\/\/.+/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,60}$/;

/**
 * How long one clicker's `link.clicked` events collapse into a single outbox
 * row. Ten minutes: long enough to swallow a scanner's retries, a double-click
 * and a back-button re-open, short enough that someone genuinely returning to
 * the link later in the day still trips the automation. It is a floor-divided
 * window, so two clicks either side of a boundary both emit — a burst-collapse,
 * not a lock.
 */
const CLICK_EVENT_WINDOW_MS = 10 * 60_000;

export interface CreateTriggerLinkInput {
  name: string;
  targetUrl: string;
  slug?: string;
}
export interface UpdateTriggerLinkInput {
  name?: string;
  targetUrl?: string;
  slug?: string;
}

/**
 * Standalone trigger links (GoHighLevel parity). A short link that 302s to a
 * workspace-authored target and, per click, records a TriggerLinkClick + emits
 * the `link.clicked` workflow trigger. `slug` is globally unique (the public
 * route has no workspace context). CRUD is workspace-scoped; the public click
 * path resolves by the globally-unique slug (findUnique — exempt).
 */
@Injectable()
export class TriggerLinksService {
  private readonly logger = new Logger(TriggerLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
  }
  /**
   * The public click URL for a slug (what the QR encodes and the UI copies).
   *
   * Pass `contact` to mint the per-lead attribution link a send should use.
   * When the platform cannot sign (no `MARKETING_SECRET_KEY`) the `?c=` is
   * omitted rather than emitted raw — an unsigned id would be refused by
   * `click()` on the very deployments that CAN sign, so printing one would be
   * printing a link we know does not attribute.
   */
  publicUrl(slug: string, contact?: { workspaceId: string; leadId: string }): string {
    const base = `${this.baseUrl()}/api/public/l/${slug}`;
    if (!contact) return base;
    const token = signTriggerLinkContact(contact.workspaceId, contact.leadId);
    return token ? `${base}?c=${token}` : base;
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.triggerLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];

    // `clickCount` CHANGED MEANING: it is the HUMAN counter now, because a
    // mail-security scanner sweeping every link in a mail no longer bumps it.
    // For a tenant with no scanner traffic the number is what it always was;
    // for everyone else it fell overnight, and A5.1 says a tenant must be able
    // to see why. This list is the only surface that renders these links.
    //
    // One grouped read for the page, workspace named in the predicate. A
    // failure is UNKNOWN, not zero: "0 filtered" is a claim we cannot make, and
    // a counting read must never be able to empty the page it annotates.
    const ids = rows.map((r) => r.id);
    const totals = await this.prisma.triggerLinkClick
      .groupBy({
        by: ['triggerLinkId'],
        where: { workspaceId, triggerLinkId: { in: ids } },
        _count: { _all: true },
      })
      .catch((e: any) => {
        this.logger.warn(`trigger-link click totals unreadable (workspace=${workspaceId}): ${e?.message ?? e}`);
        return null;
      });
    const totalById = new Map<string, number>(
      (totals ?? []).map((t: any) => [String(t.triggerLinkId), Number(t._count?._all ?? 0)]),
    );

    return rows.map((r) => {
      const total = totals ? (totalById.get(r.id) ?? 0) : null;
      return {
        ...r,
        url: this.publicUrl(r.slug),
        totalClicks: total,
        // Never negative: a counter bumped by a path that wrote no row, or a
        // row aged out by retention, would otherwise read as nonsense.
        botCount: total === null ? null : Math.max(0, total - (r.clickCount ?? 0)),
      };
    });
  }

  async create(workspaceId: string, dto: CreateTriggerLinkInput) {
    if (!HTTP_URL.test(dto.targetUrl)) {
      throw new BadRequestException('targetUrl must be an http(s) URL');
    }
    const slug = dto.slug ? this.normalizeSlug(dto.slug) : this.randomSlug();
    try {
      const row = await this.prisma.triggerLink.create({
        data: { workspaceId, name: dto.name, slug, targetUrl: dto.targetUrl },
      });
      return { ...row, url: this.publicUrl(row.slug) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Slug "${slug}" is already taken`);
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: UpdateTriggerLinkInput) {
    const existing = await this.prisma.triggerLink.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Trigger link not found');
    if (dto.targetUrl !== undefined && !HTTP_URL.test(dto.targetUrl)) {
      throw new BadRequestException('targetUrl must be an http(s) URL');
    }
    try {
      const row = await this.prisma.triggerLink.update({
        where: { id: existing.id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.targetUrl !== undefined && { targetUrl: dto.targetUrl }),
          ...(dto.slug !== undefined && { slug: this.normalizeSlug(dto.slug) }),
        },
      });
      return { ...row, url: this.publicUrl(row.slug) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('That slug is already taken');
      }
      throw e;
    }
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.prisma.triggerLink.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Trigger link not found');
    await this.prisma.triggerLink.delete({ where: { id: existing.id } }); // cascades clicks
    return { message: 'Trigger link deleted' };
  }

  /**
   * Click stats + the most recent clicks for one link (scoped).
   *
   * Two numbers, because since `scanner-clicks` they answer two questions:
   *
   * - `clickCount` — the cached counter, now bumped for HUMAN clicks only. This
   *   is the badge, and it is what `list()` returns, so the list and the detail
   *   view cannot disagree.
   * - `totalClicks` — `COUNT(*)` over the rows, which are still written for
   *   every hit because they are the audit/KVKK record (exported by
   *   `ComplianceService`, erased with the subject).
   *
   * `botCount` is the difference, clamped at zero. It is an inference, not a
   * fact: `TriggerLinkClick` has no `automated` column yet, so a counter bump
   * that lost a hot-row race is indistinguishable from a scanner hit. The
   * column is the proper fix and is handed off; until then this undercounts
   * humans by a rounding error and never overstates a click that happened.
   */
  async stats(workspaceId: string, id: string) {
    const link = await this.prisma.triggerLink.findFirst({ where: { id, workspaceId } });
    if (!link) throw new NotFoundException('Trigger link not found');
    const [recent, totalClicks] = await Promise.all([
      this.prisma.triggerLinkClick.findMany({
        where: { workspaceId, triggerLinkId: id },
        orderBy: { clickedAt: 'desc' },
        take: 50,
        select: { id: true, leadId: true, clickedAt: true },
      }),
      this.prisma.triggerLinkClick.count({ where: { workspaceId, triggerLinkId: id } }),
    ]);
    return {
      ...link,
      totalClicks,
      botCount: Math.max(0, totalClicks - (link.clickCount ?? 0)),
      url: this.publicUrl(link.slug),
      recent,
    };
  }

  /**
   * Public click handler: resolve the link by its globally-unique slug, record
   * the click (+ attribute to a lead when `contactId` verifies in-workspace),
   * emit `link.clicked`, and return the validated target URL to 302 to. Returns
   * null when the slug is unknown or the stored target is unsafe (caller falls
   * back to the base URL — never an open redirect).
   *
   * `automated` says the caller believes a machine fetched this, not a person
   * (see `isAutomatedFetch`). It is a CLASSIFICATION, not a block: the row is
   * still written, because it is the audit record the KVKK export and erasure
   * both read, and the redirect still happens. What a machine does not get is
   * the two things only a human earns — the `link.clicked` workflow trigger and
   * the click counter. Corporate mail security detonating every link in a
   * campaign is the difference between 200 qualified leads and none of them.
   */
  async click(
    slug: string,
    opts: { contactId?: string; ip?: string; userAgent?: string; automated?: boolean } = {},
  ): Promise<string | null> {
    const link = await this.prisma.triggerLink.findUnique({ where: { slug } });
    if (!link) return null;
    if (!HTTP_URL.test(link.targetUrl)) return null; // never redirect to a non-http(s) target

    // Coerce the attribution param to a single string — a repeated ?c=a&c=b
    // arrives as an array under Express' simple query parser and must not throw.
    const contactId = typeof opts.contactId === 'string' ? opts.contactId : undefined;

    try {
      const claimed = this.claimedLeadId(contactId, link.workspaceId);
      // Attribute to a lead only if the id resolves IN the link's workspace; a
      // lookup failure degrades to no attribution, never dropping the click.
      let leadId: string | null = null;
      if (claimed) {
        leadId = await this.prisma.lead
          .findFirst({ where: { id: claimed, workspaceId: link.workspaceId }, select: { id: true } })
          .then((l) => l?.id ?? null)
          .catch(() => null);
      }
      await this.prisma.triggerLinkClick.create({
        data: {
          workspaceId: link.workspaceId,
          triggerLinkId: link.id,
          leadId,
          ip: opts.ip?.slice(0, 64) ?? null,
          userAgent: opts.userAgent?.slice(0, 512) ?? null,
        },
      });
      if (opts.automated) return link.targetUrl;
      // Emit the automation-critical event FIRST and independently of the display
      // counter — a counter-update failure (hot-row contention) must never steal
      // the workflow trigger. Each side-effect has its OWN catch.
      await this.outbox
        .append({
          type: MarketingEventTypes.LinkClicked,
          // Keyed on the SUBJECT and a time window, not on the click row: a
          // per-row key is unique by construction and so dedupes nothing. A
          // burst — scanner retries that slipped the classifier, a double
          // click, a leadless flood — collapses into one event here, which is
          // the only dedupe a LEADLESS enrolment gets (workflow-executor's
          // durable guard keys on the source event id, so one event per burst
          // is exactly what it needs).
          idempotencyKey: this.clickEventKey(link.id, leadId, opts.ip),
          payload: {
            workspaceId: link.workspaceId,
            triggerLinkId: link.id,
            slug: link.slug,
            leadId,
            occurredAt: new Date().toISOString(),
          },
        })
        .catch((e) => this.logger.warn(`link.clicked emit failed: ${(e as Error).message}`));
      // Best-effort HUMAN click counter — a dropped increment only understates
      // the cached badge, never the automation or the click history.
      await this.prisma.triggerLink
        .update({ where: { id: link.id }, data: { clickCount: { increment: 1 } } })
        .catch((e) => this.logger.warn(`trigger-link counter bump failed: ${(e as Error).message}`));
    } catch (e) {
      // Recording failed entirely — still redirect (resilience over analytics).
      this.logger.warn(`trigger-link click record failed: ${(e as Error).message}`);
    }
    return link.targetUrl;
  }

  /**
   * The lead a `?c=` is allowed to claim, or null.
   *
   * A signed token is the only claim accepted — a raw lead id in a query string
   * is a forgeable trigger for every `link.clicked` automation the workspace
   * owns, and ids leak through exports, forwards and former employees.
   *
   * The exception is a deployment with no `MARKETING_SECRET_KEY`: it cannot
   * MINT a signed link either, so refusing raw ids there would silently switch
   * attribution off for a workspace that has been running fine, with nothing to
   * switch it back on (G3 — a new rule defaults to today's behaviour). Nothing
   * is weakened by the fallback, because where there is no key there is no
   * signature to forge around.
   */
  private claimedLeadId(contactId: string | undefined, workspaceId: string): string | null {
    if (!contactId) return null;
    if (!canSignTriggerLinkContact()) return contactId;
    const claim = verifyTriggerLinkContact(contactId);
    // The token carries its own workspace, so a claim minted for another tenant
    // is refused before the lookup rather than relying on the scoped query.
    if (!claim || claim.workspaceId !== workspaceId) return null;
    return claim.leadId;
  }

  /** One key per (link, clicker, window) — see `CLICK_EVENT_WINDOW_MS`. */
  private clickEventKey(linkId: string, leadId: string | null, ip?: string): string {
    const subject = leadId ?? ip ?? 'anon';
    const window = Math.floor(Date.now() / CLICK_EVENT_WINDOW_MS);
    return `${MarketingEventTypes.LinkClicked}:${linkId}:${subject}:${window}`;
  }

  private normalizeSlug(raw: string): string {
    const s = raw.trim().toLowerCase();
    if (!SLUG_RE.test(s)) throw new BadRequestException('slug must be a 2-60 char lower-case slug');
    return s;
  }
  private randomSlug(): string {
    return `l${randomBytes(5).toString('hex')}`; // 11 chars, globally collision-resistant
  }
}
