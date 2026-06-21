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

const HTTP_URL = /^https?:\/\/.+/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,60}$/;

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
  /** The public click URL for a slug (what the QR encodes and the UI copies). */
  publicUrl(slug: string): string {
    return `${this.baseUrl()}/api/public/l/${slug}`;
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.triggerLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ ...r, url: this.publicUrl(r.slug) }));
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

  /** Click stats + the most recent clicks for one link (scoped). */
  async stats(workspaceId: string, id: string) {
    const link = await this.prisma.triggerLink.findFirst({ where: { id, workspaceId } });
    if (!link) throw new NotFoundException('Trigger link not found');
    // clickCount is a best-effort cache; the click rows are the truth, so report
    // the authoritative COUNT here (self-heals any dropped-increment drift).
    const [recent, clickCount] = await Promise.all([
      this.prisma.triggerLinkClick.findMany({
        where: { workspaceId, triggerLinkId: id },
        orderBy: { clickedAt: 'desc' },
        take: 50,
        select: { id: true, leadId: true, clickedAt: true },
      }),
      this.prisma.triggerLinkClick.count({ where: { workspaceId, triggerLinkId: id } }),
    ]);
    return { ...link, clickCount, url: this.publicUrl(link.slug), recent };
  }

  /**
   * Public click handler: resolve the link by its globally-unique slug, record
   * the click (+ attribute to a lead when `contactId` resolves in-workspace),
   * emit `link.clicked`, and return the validated target URL to 302 to. Returns
   * null when the slug is unknown or the stored target is unsafe (caller falls
   * back to the base URL — never an open redirect).
   */
  async click(
    slug: string,
    opts: { contactId?: string; ip?: string; userAgent?: string } = {},
  ): Promise<string | null> {
    const link = await this.prisma.triggerLink.findUnique({ where: { slug } });
    if (!link) return null;
    if (!HTTP_URL.test(link.targetUrl)) return null; // never redirect to a non-http(s) target

    // Coerce the attribution param to a single string — a repeated ?c=a&c=b
    // arrives as an array under Express' simple query parser and must not throw.
    const contactId = typeof opts.contactId === 'string' ? opts.contactId : undefined;

    try {
      // Attribute to a lead only if the id resolves IN the link's workspace; a
      // lookup failure degrades to no attribution, never dropping the click.
      let leadId: string | null = null;
      if (contactId) {
        leadId = await this.prisma.lead
          .findFirst({ where: { id: contactId, workspaceId: link.workspaceId }, select: { id: true } })
          .then((l) => l?.id ?? null)
          .catch(() => null);
      }
      const click = await this.prisma.triggerLinkClick.create({
        data: {
          workspaceId: link.workspaceId,
          triggerLinkId: link.id,
          leadId,
          ip: opts.ip?.slice(0, 64) ?? null,
          userAgent: opts.userAgent?.slice(0, 512) ?? null,
        },
      });
      // Emit the automation-critical event FIRST and independently of the display
      // counter — a counter-update failure (hot-row contention) must never steal
      // the workflow trigger. Each side-effect has its OWN catch.
      await this.outbox
        .append({
          type: MarketingEventTypes.LinkClicked,
          idempotencyKey: `${MarketingEventTypes.LinkClicked}:${click.id}`,
          payload: {
            workspaceId: link.workspaceId,
            triggerLinkId: link.id,
            slug: link.slug,
            leadId,
            occurredAt: new Date().toISOString(),
          },
        })
        .catch((e) => this.logger.warn(`link.clicked emit failed: ${(e as Error).message}`));
      // Best-effort display counter — the trigger_link_clicks rows are the truth
      // (stats() recomputes from COUNT), so a dropped increment only undercounts
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

  private normalizeSlug(raw: string): string {
    const s = raw.trim().toLowerCase();
    if (!SLUG_RE.test(s)) throw new BadRequestException('slug must be a 2-60 char lower-case slug');
    return s;
  }
  private randomSlug(): string {
    return `l${randomBytes(5).toString('hex')}`; // 11 chars, globally collision-resistant
  }
}
