import { Injectable, Logger, ServiceUnavailableException, HttpException, HttpStatus } from '@nestjs/common';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { NetgsmStatisticsClient, StatisticsDailyAggregate } from '../../netgsm/santral/netgsm-statistics.client';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { rangeEndInclusive } from './report-date-range.util';

const STATISTICS_BUDGET_LIMIT = 2;
const STATISTICS_BUDGET_WINDOW_MS = 60_000;
/** NetGSM's own mode-1 hard cap: daily aggregates only cover a ≤7-day window. */
const MAX_WINDOW_MS = 7 * 24 * 3_600_000;

export interface TelephonyStatisticsSummary {
  answered: number;
  abandoned: number;
  /** Weighted by daily call volume; null when no day reported a wait time. */
  avgWaitSec: number | null;
}

export interface TelephonyStatisticsResult {
  /** yyyy-MM-dd — the EFFECTIVE (possibly clamped) window start. */
  from: string;
  /** yyyy-MM-dd — the effective window end. */
  to: string;
  /** True when the requested range exceeded 7 days and was clamped to the trailing week. */
  clamped: boolean;
  /** False when NetGSM rejected the request (e.g. off-prod IP not allow-listed) — daily/summary are still safe zeros, not an error. */
  ok: boolean;
  code?: string;
  message?: string;
  daily: StatisticsDailyAggregate[];
  summary: TelephonyStatisticsSummary;
}

/**
 * Inbound call statistics for the marketing reports page (NetGSM Phase 4 Task
 * 5) — daily aggregates (answered/abandoned/avg-wait) from
 * `/netsantral/statistics` mode 1, budgeted at NetGSM's 2 req/min per account
 * via `AccountRateBudgeter('statistics')` (mirrors how iys-sync/blacklist-sync/
 * dlr-poll budget their own NetGSM buckets — checked here, not inside the
 * client). Same production-IP allow-list caveat as the CDR probe
 * (`CallCdrSyncService.testFetch` / TelephonyCard's `showCdrNote`): off-prod,
 * NetGSM rejects with a pre-auth error envelope — this surfaces as
 * `{ok:false, code}` on the response rather than throwing, so the reports
 * panel can render a "production only" note instead of an error page.
 */
@Injectable()
export class TelephonyReportsService {
  private readonly logger = new Logger(TelephonyReportsService.name);

  constructor(
    private readonly telephonyConfig: TelephonyConfigService,
    private readonly client: NetgsmStatisticsClient,
    private readonly budgeter: AccountRateBudgeter,
  ) {}

  /** GET /marketing/telephony/statistics?from&to */
  async statistics(workspaceId: string, from?: string, to?: string): Promise<TelephonyStatisticsResult> {
    const creds = await this.resolveCreds(workspaceId);
    const { fromDate, toDate, clamped } = resolveWindow(from, to);

    if (!this.budgeter.tryTake(creds.usercode, 'statistics', STATISTICS_BUDGET_LIMIT, STATISTICS_BUDGET_WINDOW_MS)) {
      throw new HttpException(
        { message: 'NetGSM statistics rate limit reached (2 requests/min) — try again shortly.', retryable: true },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const outcome = await this.client.fetchStatistics(creds, {
      mode: 1,
      startdate: fmtTr(fromDate),
      stopdate: fmtTr(toDate),
    });
    const daily = outcome.daily ?? [];
    if (!outcome.ok) {
      this.logger.warn(`netgsm statistics rejected code=${outcome.code ?? '?'} ${outcome.message ?? ''}`);
    }
    return {
      from: toDateOnly(fromDate),
      to: toDateOnly(toDate),
      clamped,
      ok: outcome.ok,
      ...(outcome.code ? { code: outcome.code } : {}),
      ...(outcome.message ? { message: outcome.message } : {}),
      daily,
      summary: summarize(daily),
    };
  }

  private async resolveCreds(workspaceId: string): Promise<{ usercode: string; password: string }> {
    const cfg = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    if (!cfg) throw new ServiceUnavailableException('Netsantral is not configured for this workspace');
    return { usercode: cfg.username, password: cfg.password };
  }
}

/** Sum answered/abandoned; weight the average wait by each day's (answered+abandoned) call volume. */
function summarize(daily: StatisticsDailyAggregate[]): TelephonyStatisticsSummary {
  let answered = 0;
  let abandoned = 0;
  let weightedWait = 0;
  let waitWeight = 0;
  for (const d of daily) {
    answered += d.answered;
    abandoned += d.abandoned;
    if (d.avgWaitSec != null) {
      const weight = d.answered + d.abandoned || 1;
      weightedWait += d.avgWaitSec * weight;
      waitWeight += weight;
    }
  }
  return { answered, abandoned, avgWaitSec: waitWeight > 0 ? Math.round(weightedWait / waitWeight) : null };
}

/**
 * Resolve the [from,to] window from optional `yyyy-MM-dd` query params,
 * defaulting to the trailing 7 days, and CLAMP to NetGSM mode-1's ≤7-day cap
 * (keeps the most recent days when the requested span is wider) rather than
 * rejecting the request — a manager picking too wide a range should still see
 * the freshest week, not an error.
 */
function resolveWindow(from?: string, to?: string): { fromDate: Date; toDate: Date; clamped: boolean } {
  const toDate = to ? rangeEndInclusive(to) : new Date();
  const requestedFrom = from ? new Date(from) : new Date(toDate.getTime() - 6 * 24 * 3_600_000);
  let fromDate = requestedFrom;
  let clamped = false;
  if (toDate.getTime() - fromDate.getTime() > MAX_WINDOW_MS) {
    fromDate = new Date(toDate.getTime() - MAX_WINDOW_MS);
    clamped = true;
  }
  if (fromDate.getTime() > toDate.getTime()) fromDate = toDate; // malformed input guard (from after to)
  return { fromDate, toDate, clamped };
}

/** Format a Date as NetGSM's ddMMyyyyHHmm in Turkey local time (UTC+3). Mirrors CallCdrSyncService's fmtTr. */
function fmtTr(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}${p(t.getUTCMonth() + 1)}${t.getUTCFullYear()}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
