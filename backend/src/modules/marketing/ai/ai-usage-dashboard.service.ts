import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { zonedWallTimeToUtcMs } from "../sites/timezone-slots";
import { AI_CREDIT_COSTS, AiAction } from "./ai-credit-costs";
import { AI_JOBS, jobPolicy } from "./ai-job-policy";
import { dashboardUsdFor } from "./ai-dashboard-prices";

const DAY = 86_400_000;
const ENTRY_ACTIONS = new Set([
  "ask_ai.question",
  "command.request",
  "research.qualify",
  "strategy.synthesize",
]);
const EXTERNAL_ACTIONS = new Set([
  "stt.minute",
  "social.publish.x",
  "social.publish.x_link",
]);
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
] as const;

type Kind = "TOKEN" | "MEDIA" | "EXTERNAL" | "ENTRY";
interface ModelUsage {
  model: string;
  calls: number;
  tokens: number | null;
  costUsd: number | null;
  priceKnown: boolean;
}
export interface DashboardUsageRow {
  action: string;
  label: string;
  category: string;
  kind: Kind;
  calls: number | null;
  tokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  webSearches: number;
  costUsd: number | null;
  averageTokens: number | null;
  averageCostUsd: number | null;
  unpricedCalls: number;
  creditRate: number | null;
  creditUnit: "call" | "minute" | "image" | "second" | "dynamic";
  models: ModelUsage[];
}
interface DailyUsage {
  day: string;
  tokens: number;
  calls: number;
  llmCostUsd: number;
  mediaCostUsd: number;
  knownCostUsd: number;
}
interface TokenGroup {
  day: string;
  action: string;
  model: string;
  calls: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheWriteTokens: bigint;
  cacheReadTokens: bigint;
  webSearches: bigint;
}
interface MediaGroup {
  day: string;
  type: string;
  model: string;
  calls: bigint;
  costUsd: Prisma.Decimal | null;
  unpriced: bigint;
}
export interface AiUsageDashboard {
  generatedAt: string;
  currency: "USD";
  period: ReturnType<typeof dashboardMonth>;
  totals: {
    tokens: number;
    calls: number;
    llmCostUsd: number;
    mediaCostUsd: number;
    knownCostUsd: number;
    unpricedCalls: number;
    unpricedMediaJobs: number;
  };
  forecast: {
    tokens: number | null;
    costUsd: number | null;
    dailyTokens: number | null;
    dailyCostUsd: number | null;
    observedDays: number;
    remainingDays: number;
    basis: "MONTH_TO_DATE";
    reason: "INSUFFICIENT_HISTORY" | "NO_ACTIVITY" | null;
  };
  daily: DailyUsage[];
  rows: DashboardUsageRow[];
  coverage: {
    partial: boolean;
    untrackedActions: string[];
    unmappedActions: string[];
  };
}

/** Calendar time as a UTC-shaped timestamp, used only for day fractions, never SQL. */
function wallTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour,
    +p.minute,
    +p.second,
    date.getUTCMilliseconds(),
  );
}
export function dashboardMonth(timezone: string, now: Date) {
  timezone ||= "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
  } catch {
    timezone = "UTC";
  }
  const localMs = wallTime(now, timezone);
  const local = new Date(localMs);
  const y = local.getUTCFullYear(),
    m = local.getUTCMonth();
  const monthStartWall = Date.UTC(y, m, 1);
  return {
    month: local.toISOString().slice(0, 7),
    timezone,
    from: new Date(
      zonedWallTimeToUtcMs(y, m + 1, 1, 0, 0, timezone),
    ).toISOString(),
    to: now.toISOString(),
    elapsedDays: (localMs - monthStartWall) / DAY,
    totalDays: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
  };
}
function emptyRow(action: string): DashboardUsageRow {
  const def = AI_JOBS[action];
  const kind: Kind = action.startsWith("media.")
    ? "MEDIA"
    : EXTERNAL_ACTIONS.has(action)
      ? "EXTERNAL"
      : ENTRY_ACTIONS.has(action)
        ? "ENTRY"
        : "TOKEN";
  const token = kind === "TOKEN";
  return {
    action,
    label: def?.label ?? action,
    category: def?.category ?? "other",
    kind,
    calls: kind === "EXTERNAL" || kind === "ENTRY" ? null : 0,
    tokens: token ? 0 : null,
    inputTokens: token ? 0 : null,
    outputTokens: token ? 0 : null,
    cacheWriteTokens: token ? 0 : null,
    cacheReadTokens: token ? 0 : null,
    webSearches: 0,
    costUsd: token || kind === "MEDIA" ? 0 : null,
    averageTokens: null,
    averageCostUsd: null,
    unpricedCalls: 0,
    // Published credit tariffs, NOT measured debits or vendor dollars.
    creditRate:
      kind === "MEDIA"
        ? null
        : (AI_CREDIT_COSTS[action as AiAction]?.credits ??
          (action === "brand.safety"
            ? AI_CREDIT_COSTS["workflow.ai_classify"].credits
            : null)),
    creditUnit:
      kind === "MEDIA"
        ? "dynamic"
        : action === "stt.minute"
          ? "minute"
          : "call",
    models: [],
  };
}
function addModel(
  row: DashboardUsageRow,
  model: string,
  calls: number,
  tokens: number | null,
  cost: number | null,
  priceKnown: boolean,
) {
  const existing = row.models.find((m) => m.model === model);
  if (!existing)
    row.models.push({ model, calls, tokens, costUsd: cost, priceKnown });
  else {
    existing.calls += calls;
    if (tokens !== null) existing.tokens = (existing.tokens ?? 0) + tokens;
    if (cost !== null) existing.costUsd = (existing.costUsd ?? 0) + cost;
    existing.priceKnown &&= priceKnown;
  }
}

/** Read-only reporting; no quota mutations, provider calls, or legacy report changes. */
@Injectable()
export class AiUsageDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string, now = new Date()): Promise<AiUsageDashboard> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true, createdAt: true, aiSpendPolicy: true },
    });
    if (!workspace) throw new NotFoundException("Workspace not found");
    const period = dashboardMonth(workspace.timezone ?? "UTC", now);
    const from = new Date(period.from);
    // Group in PostgreSQL rather than loading every call into the API process.
    // Prisma timestamps are stored without timezone, with UTC values.
    const [logs, media] = await Promise.all([
      this.prisma.$queryRaw<TokenGroup[]>(Prisma.sql`
        SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${period.timezone}, 'YYYY-MM-DD') AS day,
          action, model, count(*) AS calls,
          sum("inputTokens") AS "inputTokens", sum("outputTokens") AS "outputTokens",
          sum("cacheWriteTokens") AS "cacheWriteTokens", sum("cacheReadTokens") AS "cacheReadTokens",
          sum("webSearches") AS "webSearches"
        FROM ai_usage_logs
        WHERE "workspaceId" = ${workspaceId} AND "createdAt" >= ${from} AND "createdAt" <= ${now}
        GROUP BY day, action, model
        ORDER BY day, action, model`),
      this.prisma.$queryRaw<MediaGroup[]>(Prisma.sql`
        SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${period.timezone}, 'YYYY-MM-DD') AS day,
          type, model, count(*) AS calls, sum("costUsd") AS "costUsd",
          count(*) FILTER (WHERE "costUsd" IS NULL) AS unpriced
        FROM generated_assets
        WHERE "workspaceId" = ${workspaceId} AND status = 'READY'
          AND "createdAt" >= ${from} AND "createdAt" <= ${now}
        GROUP BY day, type, model
        ORDER BY day, type, model`),
    ]);
    const rows = new Map(Object.keys(AI_JOBS).map((id) => [id, emptyRow(id)]));
    const daily = new Map<string, DailyUsage>();
    for (let d = 1; d <= Math.floor(period.elapsedDays) + 1; d++) {
      const day = `${period.month}-${String(d).padStart(2, "0")}`;
      daily.set(day, {
        day,
        tokens: 0,
        calls: 0,
        llmCostUsd: 0,
        mediaCostUsd: 0,
        knownCostUsd: 0,
      });
    }
    const rowFor = (action: string) => {
      if (!rows.has(action)) rows.set(action, emptyRow(action));
      return rows.get(action)!;
    };
    let llmCostUsd = 0,
      mediaCostUsd = 0,
      tokens = 0,
      calls = 0,
      unpricedCalls = 0,
      unpricedMediaJobs = 0;
    for (const log of logs) {
      const row = rowFor(log.action);
      const usage = {
        inputTokens: Number(log.inputTokens),
        outputTokens: Number(log.outputTokens),
        cacheWriteTokens: Number(log.cacheWriteTokens),
        cacheReadTokens: Number(log.cacheReadTokens),
        webSearches: Number(log.webSearches),
      };
      const tokenCount = TOKEN_FIELDS.reduce(
        (sum, field) => sum + usage[field],
        0,
      );
      const count = Number(log.calls);
      const cost = dashboardUsdFor(log.model, usage);
      if (!row.calls) row.costUsd = null;
      row.calls = (row.calls ?? 0) + count;
      row.tokens = (row.tokens ?? 0) + tokenCount;
      for (const field of TOKEN_FIELDS)
        row[field] = (row[field] ?? 0) + usage[field];
      row.webSearches += usage.webSearches;
      if (cost !== null) row.costUsd = (row.costUsd ?? 0) + cost;
      else {
        row.unpricedCalls += count;
        unpricedCalls += count;
      }
      addModel(row, log.model, count, tokenCount, cost, cost !== null);
      calls += count;
      tokens += tokenCount;
      llmCostUsd += cost ?? 0;
      const day = daily.get(log.day)!;
      day.calls += count;
      day.tokens += tokenCount;
      day.llmCostUsd += cost ?? 0;
      day.knownCostUsd += cost ?? 0;
    }
    for (const asset of media) {
      const row = rowFor(`media.${asset.type.toLowerCase()}.generate`);
      const count = Number(asset.calls),
        missing = Number(asset.unpriced);
      const cost = asset.costUsd === null ? null : Number(asset.costUsd);
      if (!row.calls) row.costUsd = null;
      row.calls = (row.calls ?? 0) + count;
      row.unpricedCalls += missing;
      if (cost !== null) row.costUsd = (row.costUsd ?? 0) + cost;
      addModel(row, asset.model ?? "unknown", count, null, cost, missing === 0);
      calls += count;
      mediaCostUsd += cost ?? 0;
      unpricedMediaJobs += missing;
      const day = daily.get(asset.day)!;
      day.calls += count;
      day.mediaCostUsd += cost ?? 0;
      day.knownCostUsd += cost ?? 0;
    }
    for (const row of rows.values()) {
      if (row.calls) {
        row.averageTokens = row.tokens === null ? null : row.tokens / row.calls;
        const pricedCalls = row.calls - row.unpricedCalls;
        row.averageCostUsd =
          row.costUsd === null || pricedCalls === 0
            ? null
            : row.costUsd / pricedCalls;
      }
    }
    const monthWall = Date.parse(`${period.month}-01T00:00:00Z`);
    const createdWall = wallTime(workspace.createdAt, period.timezone);
    const observedDays = Math.max(
      0,
      Math.min(
        period.elapsedDays,
        (wallTime(now, period.timezone) - Math.max(monthWall, createdWall)) /
          DAY,
      ),
    );
    const remainingDays = Math.max(0, period.totalDays - period.elapsedDays);
    // Eligibility uses real elapsed hours; the rate uses local calendar days.
    // A fall-back day can have 24 observed hours but only 23 wall-clock hours.
    const observedMs =
      now.getTime() - Math.max(from.getTime(), workspace.createdAt.getTime());
    const reason = !calls
      ? "NO_ACTIVITY"
      : observedMs < DAY || observedDays <= 0
        ? "INSUFFICIENT_HISTORY"
        : null;
    const knownCostUsd = llmCostUsd + mediaCostUsd;
    const hasPricedUsage = calls > unpricedCalls + unpricedMediaJobs;
    const dailyTokens = reason ? null : tokens / observedDays;
    const dailyCostUsd =
      reason || !hasPricedUsage ? null : knownCostUsd / observedDays;
    const untrackedActions = [
      ...new Set([
        ...EXTERNAL_ACTIONS,
        ...Object.keys(AI_JOBS).filter(
          (id) =>
            jobPolicy(workspace.aiSpendPolicy as Record<string, unknown>, id)
              .provider !== "API",
        ),
      ]),
    ];
    return {
      generatedAt: now.toISOString(),
      currency: "USD",
      period,
      totals: {
        tokens,
        calls,
        llmCostUsd,
        mediaCostUsd,
        knownCostUsd,
        unpricedCalls,
        unpricedMediaJobs,
      },
      forecast: {
        tokens:
          dailyTokens === null
            ? null
            : Math.round(tokens + dailyTokens * remainingDays),
        costUsd:
          dailyCostUsd === null
            ? null
            : knownCostUsd + dailyCostUsd * remainingDays,
        dailyTokens,
        dailyCostUsd,
        observedDays,
        remainingDays,
        basis: "MONTH_TO_DATE",
        reason,
      },
      daily: [...daily.values()],
      rows: [...rows.values()],
      coverage: {
        partial: !!(
          untrackedActions.length ||
          unpricedCalls ||
          unpricedMediaJobs
        ),
        untrackedActions,
        unmappedActions: [...rows.keys()].filter(
          (id) => !Object.prototype.hasOwnProperty.call(AI_JOBS, id),
        ),
      },
    };
  }
}
