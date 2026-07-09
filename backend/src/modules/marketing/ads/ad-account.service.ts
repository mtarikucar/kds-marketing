import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../common/crypto/secret-box.helper';
import { pullMetaInsights } from './meta-ads.client';
import { pullTiktokInsights } from './tiktok-ads.client';
import { pullLinkedinInsights } from './linkedin-ads.client';
import { pullGoogleInsights } from './google-ads.client';
import { isGoogleAuthError } from './google-ads.util';
import { pullMetaBreakdowns, AdBreakdownRow } from './meta-ads-breakdown.client';
import {
  isMetaAdsConfigured,
  isTiktokAdsConfigured,
  isLinkedinAdsConfigured,
  isGoogleAdsConfigured,
  AdMetricRow,
} from './ads.types';
import { ConnectAdAccountDto } from '../dto/ad-account.dto';
import { isMetaAuthError } from '../../../common/util/meta-graph.util';
import { isLinkedinAuthError } from '../../../common/util/linkedin-api.util';

const PROVIDERS = ['META', 'TIKTOK', 'LINKEDIN', 'GOOGLE'];

/**
 * Ad-account connection + metrics (GoHighLevel parity). Each workspace connects
 * its OWN Meta/TikTok ad account (per-tenant); the access token is SEALED and
 * never returned. pullAccount fetches provider insights and idempotently upserts
 * AdMetric rows. Workspace-owned: every multi-row/create query inlines
 * `workspaceId`; the cross-workspace due-account sweep lives in the scheduler.
 */
@Injectable()
export class AdAccountService {
  private readonly logger = new Logger(AdAccountService.name);

  constructor(private readonly prisma: PrismaService) {}

  status() {
    return {
      META: isMetaAdsConfigured(),
      TIKTOK: isTiktokAdsConfigured(),
      LINKEDIN: isLinkedinAdsConfigured(),
      GOOGLE: isGoogleAdsConfigured(),
      secretBoxConfigured: isSecretBoxConfigured(),
    };
  }

  /** Accounts WITHOUT the sealed token (never echo the capability). */
  list(workspaceId: string) {
    return this.prisma.adAccount.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        externalAdId: true,
        displayName: true,
        status: true,
        currency: true,
        lastPulledAt: true,
        lastError: true,
        createdAt: true,
      },
    });
  }

  async connect(workspaceId: string, dto: ConnectAdAccountDto) {
    if (!PROVIDERS.includes(dto.provider)) {
      throw new BadRequestException('provider must be META, TIKTOK, LINKEDIN or GOOGLE');
    }
    // Env-gate the user path the same way the cron sweep is gated, so the whole
    // feature is inert (and /status is truthful) when a provider isn't enabled.
    if (!this.isProviderConfigured(dto.provider)) {
      throw new BadRequestException(`${dto.provider} ads is not configured on this platform`);
    }
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    const sealed = sealSecret(dto.accessToken);
    // pixelId is non-secret config; capiToken (optional) is sealed like the main
    // token. Only write them when supplied so a re-connect that omits them keeps
    // any previously-configured CAPI destination.
    const capiSealed = dto.capiToken ? sealSecret(dto.capiToken) : undefined;
    // Re-connecting the same (workspace, provider, account) rotates the token.
    return this.prisma.adAccount.upsert({
      where: {
        workspaceId_provider_externalAdId: {
          workspaceId,
          provider: dto.provider,
          externalAdId: dto.externalAdId,
        },
      },
      create: {
        workspaceId,
        provider: dto.provider,
        externalAdId: dto.externalAdId,
        displayName: dto.displayName ?? dto.externalAdId,
        accessToken: sealed,
        currency: dto.currency ?? null,
        status: 'ACTIVE',
        ...(dto.pixelId ? { pixelId: dto.pixelId } : {}),
        ...(capiSealed ? { capiToken: capiSealed } : {}),
      },
      update: {
        accessToken: sealed,
        displayName: dto.displayName ?? dto.externalAdId,
        currency: dto.currency ?? null,
        status: 'ACTIVE',
        lastError: null,
        ...(dto.pixelId !== undefined ? { pixelId: dto.pixelId || null } : {}),
        ...(capiSealed ? { capiToken: capiSealed } : {}),
      },
      select: { id: true, provider: true, externalAdId: true, displayName: true, status: true },
    });
  }

  async remove(workspaceId: string, id: string) {
    const acc = await this.prisma.adAccount.findFirst({ where: { id, workspaceId } });
    if (!acc) throw new NotFoundException('Ad account not found');
    await this.prisma.adAccount.delete({ where: { id } }); // cascades ad_metrics
    return { message: 'Ad account disconnected' };
  }

  /** Aggregated metrics for the workspace over a date range, by provider + day. */
  async getMetrics(workspaceId: string, from: string, to: string, provider?: string) {
    const accounts = await this.prisma.adAccount.findMany({
      where: { workspaceId, ...(provider ? { provider } : {}) },
      select: { id: true, provider: true },
    });
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) return { totals: empty(), byDay: [], byProvider: {} };

    const rows = await this.prisma.adMetric.findMany({
      where: { workspaceId, adAccountId: { in: ids }, date: { gte: new Date(from), lte: new Date(to) } },
      orderBy: { date: 'asc' },
    });
    const providerOf = new Map(accounts.map((a) => [a.id, a.provider]));
    // Accumulate spend in integer cents (not JS floats) so summing many
    // Decimal(14,2) values can't drift by sub-cent epsilon; convert back at the
    // end. totals/byDay/byProvider share the identical path so they stay equal.
    const totals = acc0();
    const byDay = new Map<string, ReturnType<typeof acc0>>();
    const byProvider: Record<string, ReturnType<typeof acc0>> = {};
    for (const r of rows) {
      const day = r.date.toISOString().slice(0, 10);
      const prov = providerOf.get(r.adAccountId) ?? 'UNKNOWN';
      const add = (a: ReturnType<typeof acc0>) => {
        a.spendCents += Math.round(Number(r.spend) * 100);
        a.impressions += r.impressions;
        a.clicks += r.clicks;
        a.leads += r.leads;
        a.revenueCents += Math.round(Number(r.revenue) * 100);
      };
      add(totals);
      add((byDay.get(day) ?? byDay.set(day, acc0()).get(day))!);
      add((byProvider[prov] ??= acc0()));
    }
    return {
      totals: bucket(totals),
      byProvider: Object.fromEntries(
        Object.entries(byProvider).map(([k, v]) => [k, bucket(v)]),
      ),
      byDay: [...byDay.entries()].map(([date, m]) => ({ date, ...bucket(m) })),
    };
  }

  /**
   * Pull provider insights for one account over [from,to] and idempotently
   * upsert AdMetric rows. Returns the count written. Records lastPulledAt /
   * lastError on the account. Called by the scheduler and the manual-pull route.
   */
  async pullAccount(
    account: { id: string; workspaceId: string; provider: string; externalAdId: string; accessToken: string },
    from: string,
    to: string,
  ): Promise<number> {
    // Inert when the provider isn't enabled platform-wide (mirrors connect()).
    if (!this.isProviderConfigured(account.provider)) {
      await this.markError(account.id, `${account.provider} ads is not configured on this platform`);
      return 0;
    }
    let token: string;
    try {
      token = openSecret(account.accessToken);
    } catch {
      await this.markError(account.id, 'access token could not be decrypted');
      return 0;
    }
    let rows: AdMetricRow[];
    try {
      if (account.provider === 'META') {
        rows = await pullMetaInsights(token, account.externalAdId, from, to);
      } else if (account.provider === 'TIKTOK') {
        rows = await pullTiktokInsights(token, account.externalAdId, from, to);
      } else if (account.provider === 'GOOGLE') {
        // token here is the sealed OAuth REFRESH token; the client mints the
        // ~1h access token itself, so no service-layer refresh is needed.
        rows = await pullGoogleInsights(token, account.externalAdId, from, to);
      } else {
        rows = await pullLinkedinInsights(token, account.externalAdId, from, to);
      }
    } catch (e) {
      // A token problem → mark needs-reauth so the ACTIVE-only hourly sweep stops
      // hammering the provider until the operator reconnects. Meta: Graph code
      // 190 / HTTP 401 / auth subcode (isMetaAuthError). TikTok: business-API
      // auth code or token message. LinkedIn: isLinkedinAuthError. Other errors
      // keep the retry-friendly markError path (status stays ACTIVE).
      const msg = (e as Error).message ?? 'pull failed';
      const needsReauth =
        (account.provider === 'META' && isMetaAuthError(e)) ||
        (account.provider === 'TIKTOK' &&
          /access[_ ]?token|auth|not authorized|invalid token|\b(4000[12]|4010\d|40110)\b/i.test(msg)) ||
        (account.provider === 'LINKEDIN' && isLinkedinAuthError(e)) ||
        (account.provider === 'GOOGLE' && isGoogleAuthError(e));
      if (needsReauth) {
        await this.markReauth(account.id);
      } else {
        await this.markError(account.id, msg.slice(0, 1000));
      }
      return 0;
    }
    // Guard the DB writes too: if an upsert/update fails (serialization, deadlock,
    // connection drop), record it via markError — which stamps lastPulledAt — so
    // the row rotates to the BACK of the lastPulledAt-ordered sweep queue instead
    // of staying at the nulls-first front and starving healthy accounts.
    try {
      for (const row of rows) {
        const date = new Date(`${row.date}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime())) continue;
        // Providers that don't report purchase value (TikTok/LinkedIn today)
        // must not clobber an existing conversionValue — only mirror it when
        // the row actually carries the field.
        const hasCv = row.conversionValue != null;
        const conversionValue = new Prisma.Decimal(row.conversionValue ?? 0);
        await this.prisma.adMetric.upsert({
          where: {
            adAccountId_date_campaignId: { adAccountId: account.id, date, campaignId: row.campaignId },
          },
          create: {
            workspaceId: account.workspaceId,
            adAccountId: account.id,
            date,
            campaignId: row.campaignId,
            spend: row.spend,
            impressions: row.impressions,
            clicks: row.clicks,
            leads: row.leads,
            ...(hasCv ? { conversionValue } : {}),
            rawMetrics: row.raw as Prisma.InputJsonValue,
          },
          update: {
            spend: row.spend,
            impressions: row.impressions,
            clicks: row.clicks,
            leads: row.leads,
            ...(hasCv ? { conversionValue } : {}),
            rawMetrics: row.raw as Prisma.InputJsonValue,
            pulledAt: new Date(),
          },
        });
        // Cold-start revenue (D10): provider-reported purchase value backfills
        // AdMetric.revenue ONLY while it is still 0 — first-party CRM revenue
        // (the performance loop's recompute) always wins over platform
        // self-attribution, so a guarded updateMany, never a blind write.
        if (conversionValue.gt(0)) {
          await this.prisma.adMetric.updateMany({
            where: {
              workspaceId: account.workspaceId,
              adAccountId: account.id,
              date,
              campaignId: row.campaignId,
              revenue: 0,
            },
            data: { revenue: conversionValue },
          });
        }
      }
      await this.prisma.adAccount.update({
        where: { id: account.id },
        // A successful pull also clears a prior reauth state (status back to
        // ACTIVE) so a reconnected account rejoins the sweep.
        data: { lastPulledAt: new Date(), lastError: null, status: 'ACTIVE' },
      });
    } catch (e) {
      await this.markError(account.id, (e as Error).message?.slice(0, 1000) ?? 'metric write failed');
      return 0;
    }
    // Granular ad-level breakdowns (Meta only) → the separate reporting table.
    // Best-effort: a breakdown failure never fails the campaign-metric pull above.
    if (account.provider === 'META') {
      try {
        await this.pullBreakdowns(account, token, from, to);
      } catch (e) {
        this.logger.warn(`breakdown pull failed for ${account.id}: ${(e as Error).message ?? e}`);
      }
    }
    return rows.length;
  }

  /** Pull Meta level=ad placement+demographic breakdowns → ad_metric_breakdowns. */
  private async pullBreakdowns(
    account: { id: string; workspaceId: string; externalAdId: string },
    token: string,
    from: string,
    to: string,
  ): Promise<void> {
    const rows: AdBreakdownRow[] = await pullMetaBreakdowns(token, account.externalAdId, from, to);
    for (const r of rows) {
      const date = new Date(`${r.date}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) continue;
      const data = {
        adAccountId: account.id,
        date,
        level: r.level,
        campaignId: r.campaignId ?? '',
        adSetId: r.adSetId ?? '',
        adSetName: r.adSetName ?? null,
        adId: r.adId ?? '',
        adName: r.adName ?? null,
        placement: r.placement ?? '',
        breakdownType: r.breakdownType ?? '',
        breakdownValue: r.breakdownValue ?? '',
        spend: new Prisma.Decimal(r.spend ?? 0),
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        leads: r.leads ?? 0,
        conversionValue: new Prisma.Decimal(r.conversionValue ?? 0),
        leads1dClick: r.leads1dClick ?? 0,
        leads7dClick: r.leads7dClick ?? 0,
        leads1dView: r.leads1dView ?? 0,
        convValue1dClick: new Prisma.Decimal(r.convValue1dClick ?? 0),
        convValue7dClick: new Prisma.Decimal(r.convValue7dClick ?? 0),
        convValue1dView: new Prisma.Decimal(r.convValue1dView ?? 0),
      };
      await this.prisma.adMetricBreakdown.upsert({
        where: {
          adBreakdown_dim: {
            adAccountId: account.id,
            date,
            campaignId: data.campaignId,
            adSetId: data.adSetId,
            adId: data.adId,
            placement: data.placement,
            breakdownType: data.breakdownType,
            breakdownValue: data.breakdownValue,
          },
        },
        // workspaceId inlined here (not on the hoisted `data`) so the arch-fitness
        // scanner sees the scope literal.
        create: { workspaceId: account.workspaceId, ...data },
        update: { ...data, pulledAt: new Date() },
      });
    }
  }

  /**
   * Aggregated ad-level breakdown for a workspace over a date range, grouped by a
   * dimension (ad | adset | placement | age | gender | region | country) with an
   * optional attribution-window view (default | 1d_click | 7d_click | 1d_view).
   */
  async getBreakdown(
    workspaceId: string,
    from: string,
    to: string,
    q: { provider?: string; dimension: string; window?: string; campaignId?: string; adSetId?: string },
  ) {
    const accounts = await this.prisma.adAccount.findMany({
      where: { workspaceId, ...(q.provider ? { provider: q.provider } : {}) },
      select: { id: true },
    });
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) return { dimension: q.dimension, window: q.window ?? 'default', rows: [] };

    // workspaceId is inlined in the findMany call below (not on this hoisted
    // filter) so the multi-tenant arch-fitness scanner sees the scope literal.
    const filter: Prisma.AdMetricBreakdownWhereInput = {
      adAccountId: { in: ids },
      date: { gte: new Date(from), lte: new Date(to) },
      ...(q.campaignId ? { campaignId: q.campaignId } : {}),
      ...(q.adSetId ? { adSetId: q.adSetId } : {}),
    };
    const demo = ['age', 'gender', 'region', 'country'];
    if (q.dimension === 'placement') filter.placement = { not: '' };
    else if (demo.includes(q.dimension)) filter.breakdownType = q.dimension;

    const rows = await this.prisma.adMetricBreakdown.findMany({ where: { workspaceId, ...filter } });

    // Group by the dimension key; accumulate money in cents (float-drift-safe).
    const keyOf = (r: (typeof rows)[number]): { key: string; label: string } => {
      switch (q.dimension) {
        case 'placement': return { key: r.placement, label: r.placement };
        case 'adset': return { key: r.adSetId, label: r.adSetName ?? r.adSetId };
        case 'ad': return { key: r.adId, label: r.adName ?? r.adId };
        default: return { key: r.breakdownValue, label: r.breakdownValue };
      }
    };
    const win = q.window ?? 'default';
    const groups = new Map<string, { label: string; spendCents: number; impressions: number; clicks: number; leads: number; revenueCents: number }>();
    for (const r of rows) {
      const { key, label } = keyOf(r);
      const g = groups.get(key) ?? { label, spendCents: 0, impressions: 0, clicks: 0, leads: 0, revenueCents: 0 };
      g.spendCents += Math.round(Number(r.spend) * 100);
      g.impressions += r.impressions;
      g.clicks += r.clicks;
      g.leads += win === '1d_click' ? r.leads1dClick : win === '7d_click' ? r.leads7dClick : win === '1d_view' ? r.leads1dView : r.leads;
      const cv = win === '1d_click' ? r.convValue1dClick : win === '7d_click' ? r.convValue7dClick : win === '1d_view' ? r.convValue1dView : r.conversionValue;
      g.revenueCents += Math.round(Number(cv) * 100);
      groups.set(key, g);
    }
    const out = [...groups.entries()].map(([key, g]) => ({
      key,
      label: g.label,
      spend: g.spendCents / 100,
      impressions: g.impressions,
      clicks: g.clicks,
      leads: g.leads,
      revenue: g.revenueCents / 100,
      roas: g.spendCents > 0 ? g.revenueCents / g.spendCents : 0,
    }));
    out.sort((a, b) => b.spend - a.spend);
    return { dimension: q.dimension, window: win, rows: out };
  }

  /** True when the provider's app credentials are present (platform-enabled). */
  private isProviderConfigured(provider: string): boolean {
    if (provider === 'META') return isMetaAdsConfigured();
    if (provider === 'GOOGLE') return isGoogleAdsConfigured();
    if (provider === 'TIKTOK') return isTiktokAdsConfigured();
    return isLinkedinAdsConfigured();
  }

  /** Manual pull for one workspace-scoped account (last `days`). */
  async pullNow(workspaceId: string, id: string, days = 7) {
    const account = await this.prisma.adAccount.findFirst({ where: { id, workspaceId } });
    if (!account) throw new NotFoundException('Ad account not found');
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const written = await this.pullAccount(account, iso(from), iso(to));
    return { written };
  }

  private markError(id: string, message: string) {
    return this.prisma.adAccount
      .update({ where: { id }, data: { lastError: message, lastPulledAt: new Date() } })
      .catch(() => undefined);
  }

  /** Auth failure → needs-reconnect. status=TOKEN_EXPIRED drops the account out
   *  of the ACTIVE-only sweep; the UI surfaces a Reconnect affordance. */
  private markReauth(id: string) {
    return this.prisma.adAccount
      .update({
        where: { id },
        data: { status: 'TOKEN_EXPIRED', lastError: 'reauth_required', lastPulledAt: new Date() },
      })
      .catch(() => undefined);
  }
}

function empty() {
  return { spend: 0, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 };
}
/** Internal accumulator: money in integer cents to avoid float drift. */
function acc0() {
  return { spendCents: 0, impressions: 0, clicks: 0, leads: 0, revenueCents: 0 };
}
/**
 * Project an accumulator back to the public bucket (cents → major units). ROAS is
 * RECOMPUTED from aggregated revenue/spend — never a sum of the stored per-row
 * roas — so totals/byDay/byProvider stay correct across any grouping.
 */
function bucket(a: ReturnType<typeof acc0>) {
  return {
    spend: a.spendCents / 100,
    impressions: a.impressions,
    clicks: a.clicks,
    leads: a.leads,
    revenue: a.revenueCents / 100,
    roas: a.spendCents > 0 ? a.revenueCents / a.spendCents : 0,
  };
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
