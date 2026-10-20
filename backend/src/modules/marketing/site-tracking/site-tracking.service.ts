import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { isBotUserAgent } from '../../../common/util/automated-fetch';
import { workspaceLocalParts } from '../../../common/scheduling/workspace-local-day';
import { PageViewStatsService } from '../analytics/page-view-stats.service';
import { siteTrackingEnabled } from './site-tracking.flag';

export const SITE_KEY_PATTERN = /^jst_[0-9a-f]{32}$/;
/** Every stored dimension is bounded, so a crafted URL cannot grow the table without limit. */
const MAX_DIM = 100;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** An order/booking reference written in capitals with a digit, e.g. FIG-7K2M9QXA. */
/** Digits, a UUID or a long hex run — ids whatever the case (same shapes as page-view-stats). */
const STRICT_ID = /^(?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
/** Same cap as page-view-stats' routes. */
const MAX_PATH = 120;
/** Lower-case words joined by hyphens (`kisiye-ozel-figur-15cm`), at least one with a letter. */
const SLUG = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)+$/;
const UPPER_REF = /^(?=.*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+$|^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{6,}$/;

export interface PageViewHit {
  siteKey: string;
  query: { p?: string; s?: string; m?: string; c?: string; r?: string };
  referer?: string;
  userAgent?: string;
  now?: Date;
}

/**
 * A page path made safe to count (contract §7.3, C3): query and fragment
 * dropped, id-shaped segments → `:id` (PageViewStatsService.normalise), plus
 * the store-side reference shape that rule does not know — a capitalised code
 * with a digit such as an order number (`/siparis/FIG-7K2M9QXA`). Lower-case
 * product slugs like `figur-15cm` are left alone.
 */
export function normaliseSitePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.split('?')[0].split('#')[0].trim();
  if (!path.startsWith('/')) return null;
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (UPPER_REF.test(seg) || STRICT_ID.test(seg)) return ':id';
      // A readable slug stays, however long: the app-route rule reads any 21+
      // character token as a nanoid, which would erase most product pages.
      if (SLUG.test(seg.toLowerCase())) return seg.toLowerCase();
      return PageViewStatsService.normalise(`/${seg}`)?.slice(1) ?? null;
    });
  if (segments.includes(null)) return null;
  const route = `/${segments.join('/')}`;
  return route.length <= MAX_PATH ? route : null;
}

function dim(v: unknown, lower: boolean): string {
  if (typeof v !== 'string') return '';
  const t = v.trim().slice(0, MAX_DIM);
  return lower ? t.toLowerCase() : t;
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `https://Shop.com:443/x` / `shop.com` → `shop.com`; null if it is not a host name. */
function normaliseHost(input: string): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  const host = /^[a-z]+:\/\//.test(raw) ? hostOf(raw) : raw.split('/')[0].split(':')[0];
  return host && HOST.test(host) ? host : null;
}

/**
 * The jeeta.js site snippet (contract §7): per-workspace keys, and the anonymous
 * daily page-view counter its pixel feeds. Nothing that identifies a visitor —
 * no IP, no user agent, no visitor id — is ever written.
 */
@Injectable()
export class SiteTrackingService {
  private readonly logger = new Logger(SiteTrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Count one page view. Returns whether it was counted; never throws — the
   * pixel answers the same GIF either way, so a store page cannot break on us.
   */
  async recordPageView(hit: PageViewHit): Promise<boolean> {
    if (!siteTrackingEnabled()) return false;
    if (!SITE_KEY_PATTERN.test(hit.siteKey ?? '')) return false;
    if (isBotUserAgent(hit.userAgent)) return false;
    const path = normaliseSitePath(hit.query?.p);
    if (!path) return false;

    try {
      const key = await this.prisma.siteTrackingKey.findUnique({ where: { key: hit.siteKey } });
      if (!key || key.status !== 'ACTIVE') return false;
      if (key.allowedHosts.length) {
        const host = hostOf(hit.referer);
        if (!host || !key.allowedHosts.includes(host)) return false;
      }

      const ws = await this.prisma.workspace.findUnique({ where: { id: key.workspaceId }, select: { timezone: true } });
      const day = workspaceLocalParts(ws?.timezone ?? 'UTC', hit.now ?? new Date()).date;
      const date = new Date(`${day}T00:00:00.000Z`);
      const source = dim(hit.query.s, true) || '(direct)';
      const medium = dim(hit.query.m, true);
      const campaign = dim(hit.query.c, false);
      const where = { siteKeyId: key.id, date, path, source, medium, campaign };
      await this.prisma.siteTrafficDaily.upsert({
        where: { siteKeyId_date_path_source_medium_campaign: where },
        create: { workspaceId: key.workspaceId, ...where, views: 1 },
        update: { views: { increment: 1 } },
      });
      return true;
    } catch (e) {
      this.logger.warn(`page view not counted: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.siteTrackingKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, key: true, label: true, allowedHosts: true, status: true, createdAt: true, revokedAt: true },
    });
    return rows.map((r) => ({ ...r, snippet: snippetTag(r.key) }));
  }

  async createKey(workspaceId: string, input: { label?: string; allowedHosts?: string[] }) {
    const hosts: string[] = [];
    for (const h of input.allowedHosts ?? []) {
      const n = normaliseHost(h);
      if (!n) throw new BadRequestException(`"${String(h).slice(0, 80)}" is not a host name (e.g. shop.example.com).`);
      if (!hosts.includes(n)) hosts.push(n);
    }
    if (hosts.length > 20) throw new BadRequestException('At most 20 allowed hosts.');
    const row = await this.prisma.siteTrackingKey.create({
      data: {
        workspaceId,
        key: `jst_${randomBytes(16).toString('hex')}`,
        label: input.label?.trim().slice(0, 80) || null,
        allowedHosts: hosts,
      },
    });
    return { ...row, snippet: snippetTag(row.key) };
  }

  async revoke(workspaceId: string, id: string) {
    const row = await this.prisma.siteTrackingKey.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException('Site tracking key not found');
    return this.prisma.siteTrackingKey.update({
      where: { id: row.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
  }
}

/** The tag a store pastes into its pages. */
export function snippetTag(key: string): string {
  const base = (process.env.MARKETING_PUBLIC_URL?.trim() || 'https://jeetagrowth.com').replace(/\/+$/, '');
  return `<script src="${base}/jeeta.js" data-site-key="${key}" async></script>`;
}
