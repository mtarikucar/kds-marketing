import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, TrendSignal } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService } from '../scheduling/scheduled-job-runner.service';
import { TrendCandidate, TrendProvider, cleanTitle } from './providers/trend-provider';
import { GoogleTrendsRssProvider } from './providers/google-trends-rss.provider';
import { ApifyTiktokTrendsProvider } from './providers/apify-tiktok-trends.provider';
import { YoutubeTrendingProvider } from './providers/youtube-trending.provider';
import { brandRelevance, decayedScore, suggestionScore } from './trend-score.util';

export const TREND_REFRESH_KIND = 'trend.refresh';
export const TREND_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
/**
 * First refresh after a boot. WHY a minute and not the interval: schedule()
 * moves the existing PENDING row's runAt, so scheduling a boot's first run
 * TREND_REFRESH_INTERVAL_MS out pushed it back on every deploy and, with
 * restarts closer than 12h apart, no refresh ever ran. The handler
 * reschedules the full interval itself.
 */
export const TREND_BOOT_DELAY_MS = 60 * 1000;
/** Signals older than this are noise for a planner that looks a week ahead. */
export const TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_HOURS = 48;
const DEFAULT_TOP_LIMIT = 10;
/** Upper bound on rows scored in memory per top() call; the DB already
 *  orders by raw score so the tail we drop is the tail that could not win. */
const TOP_SCAN_ROWS = 300;
/**
 * The ONE region every trend reader and writer uses — the refresh job, the
 * dashboard and the planner's hook lookup. Exported so no caller hard-codes
 * its own 'TR' and reads a region the job never fills. v1 serves Turkish
 * workspaces; ops override with TREND_REGION.
 */
export const TREND_REGION = process.env.TREND_REGION ?? 'TR';

/** DI token for the provider list. Module wiring is TREND_PROVIDERS_FACTORY
 *  (register the three provider classes, then this factory) — the service
 *  stays testable with a plain array and open to a fourth source. */
export const TREND_PROVIDERS = Symbol('TREND_PROVIDERS');
export const TREND_PROVIDERS_FACTORY = {
  provide: TREND_PROVIDERS,
  useFactory: (...providers: TrendProvider[]): TrendProvider[] => providers,
  inject: [GoogleTrendsRssProvider, ApifyTiktokTrendsProvider, YoutubeTrendingProvider],
};

export interface TrendRefreshResult {
  provider: string;
  count: number;
  error?: string;
}

export interface TopTrend {
  signal: TrendSignal;
  decayed: number;
  relevance: number;
  suggestion: number;
}

export interface TopTrendOpts {
  networks?: string[];
  /** BrandProfile name + products + keywords + the programme brief, unfolded. */
  brandKeywords: string[];
  limit?: number;
  now?: Date;
}

/**
 * Region-scoped trend signals (no workspaceId: a Turkish trend is the same
 * trend for every Turkish workspace; what differs per workspace is RELEVANCE,
 * computed at read time in `top()` from that workspace's brand keywords).
 *
 * `refresh()` is the write path (12-hourly global job + manual trigger) and
 * never throws: each provider's failure is isolated into its own result row so
 * a dead Apify actor cannot blank the Google feed. `top()` is the read path
 * the planner and the programme UI share.
 */
@Injectable()
export class TrendSignalService implements OnModuleInit {
  private readonly logger = new Logger(TrendSignalService.name);
  private readonly providers: TrendProvider[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    @Optional() @Inject(TREND_PROVIDERS) providers?: TrendProvider[],
  ) {
    this.providers = providers ?? [];
  }

  onModuleInit(): void {
    this.runner.registerHandler(TREND_REFRESH_KIND, async () => {
      // refresh() already isolates provider errors; a DB-level failure is the
      // only way here, and even that must not kill the self-rescheduling chain.
      try {
        const res = await this.refresh(TREND_REGION);
        const failed = res.filter((r) => r.error);
        if (failed.length) this.logger.warn(`trend refresh partial: ${failed.map((r) => `${r.provider}: ${r.error}`).join('; ')}`);
      } catch (e) {
        this.logger.error(`trend refresh failed: ${e instanceof Error ? e.message : e}`);
      }
      return { reschedule: { runAt: new Date(Date.now() + TREND_REFRESH_INTERVAL_MS) } };
    });
    void this.scheduledJobs.schedule({
      workspaceId: 'system',
      kind: TREND_REFRESH_KIND,
      runAt: new Date(Date.now() + TREND_BOOT_DELAY_MS),
      payload: {},
      dedupKey: 'trend-refresh',
    }).catch(() => undefined);
  }

  /** Pull every enabled provider for the region and upsert what came back. */
  async refresh(region = TREND_REGION): Promise<TrendRefreshResult[]> {
    const out: TrendRefreshResult[] = [];
    for (const p of this.providers) {
      if (!p.enabled()) continue;
      let count = 0;
      try {
        const candidates = await p.fetch(region);
        for (const c of dedupe(candidates)) {
          await this.upsert(region, p.name, c);
          count++;
        }
        out.push({ provider: p.name, count });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.logger.warn(`trend provider ${p.name} failed after ${count} rows: ${error}`);
        out.push({ provider: p.name, count, error });
      }
    }
    return out;
  }

  private upsert(region: string, source: string, c: TrendCandidate): Promise<TrendSignal> {
    const observedAt = new Date();
    const shared = {
      ref: c.ref ?? null,
      score: c.score,
      source,
      observedAt,
      halfLifeHours: c.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS,
      raw: (c.raw ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    };
    return this.prisma.trendSignal.upsert({
      where: { region_network_kind_title: { region, network: c.network, kind: c.kind, title: c.title } },
      create: { region, network: c.network, kind: c.kind, title: c.title, ...shared },
      update: shared,
    });
  }

  /** Freshest, most on-brand signals first — the planner's trend hook menu. */
  async top(region: string, opts: TopTrendOpts): Promise<TopTrend[]> {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? DEFAULT_TOP_LIMIT;
    const where: Prisma.TrendSignalWhereInput = {
      region,
      observedAt: { gte: new Date(now.getTime() - TREND_WINDOW_MS) },
      ...(opts.networks?.length ? { network: { in: opts.networks } } : {}),
    };
    const rows = await this.prisma.trendSignal.findMany({ where, orderBy: { score: 'desc' }, take: TOP_SCAN_ROWS });
    return rows
      .map((signal) => {
        const decayed = decayedScore(signal.score, signal.observedAt, signal.halfLifeHours, now);
        const relevance = brandRelevance(signal.title, opts.brandKeywords);
        return { signal, decayed, relevance, suggestion: suggestionScore(decayed, relevance) };
      })
      .sort((a, b) => b.suggestion - a.suggestion)
      .slice(0, limit);
  }
}

/** One row per (network, kind, title) per batch: the unique index would make
 *  the second upsert a harmless overwrite, but the first sighting's score is
 *  the one the provider ranked, so keep it. */
function dedupe(candidates: TrendCandidate[]): TrendCandidate[] {
  const seen = new Set<string>();
  const out: TrendCandidate[] = [];
  for (const c of candidates) {
    const title = cleanTitle(c.title);
    if (!title) continue;
    const key = `${c.network} ${c.kind} ${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, title });
  }
  return out;
}
