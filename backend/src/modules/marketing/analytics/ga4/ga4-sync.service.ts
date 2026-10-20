import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { Ga4ConnectionRow, Ga4OAuthService } from './ga4-oauth.service';
import { Ga4ApiError, Ga4DataClient, Ga4Dimension, Ga4Row } from './ga4-data.client';

const DIMENSIONS: Ga4Dimension[] = ['TOTAL', 'SOURCE_MEDIUM', 'CAMPAIGN'];
/** GA4 keeps processing for a couple of days, so the last 3 are re-pulled each time. */
const ROLLING_WINDOW = '3daysAgo';
/** First pull: enough for the weekly report's previous week. */
const BACKFILL_WINDOW = '35daysAgo';
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

export type SyncOutcome =
  | { status: 'synced'; rows: number }
  | { status: 'skipped'; rows: 0 }
  | { status: 'failed'; rows: 0; error: string };

class ReauthRequired extends Error {}

/**
 * Pulls one connection's property into Ga4DailyStat (contract §6.3).
 *
 * Every day the reports return is REPLACED wholesale (delete + insert in one
 * transaction): GA4 revises recent days, and a key that drops out of a day's
 * top 50 must not linger beside the "(other)" row that now contains it.
 *
 * A 401 gets one forced token refresh; a second 401, or a refresh Google
 * refuses (revoked grant), disables the connection with REAUTH_REQUIRED so the
 * panel can ask for a reconnect instead of the cron failing every hour.
 */
@Injectable()
export class Ga4SyncService {
  private readonly logger = new Logger(Ga4SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: Ga4OAuthService,
    private readonly data: Ga4DataClient,
  ) {}

  /** The panel's "sync now". */
  async syncWorkspace(workspaceId: string, now = new Date()): Promise<SyncOutcome> {
    const conn = await this.prisma.ga4Connection.findUnique({ where: { workspaceId } });
    if (!conn) throw new NotFoundException('Google Analytics is not connected for this workspace.');
    return this.syncConnection(conn, now);
  }

  async syncConnection(conn: Ga4ConnectionRow, now = new Date()): Promise<SyncOutcome> {
    if (!conn.propertyId) return { status: 'skipped', rows: 0 };
    const startDate = conn.lastSyncedAt ? ROLLING_WINDOW : BACKFILL_WINDOW;

    try {
      let token = await this.token(conn);
      let refreshed = false;
      const pull = (dimension: Ga4Dimension) =>
        this.data.runReport(token, conn.propertyId!, { startDate, endDate: 'yesterday', dimension });
      const records: Prisma.Ga4DailyStatCreateManyInput[] = [];
      for (const dimension of DIMENSIONS) {
        let report: { currency: string | null; rows: Ga4Row[] };
        try {
          report = await pull(dimension);
        } catch (e) {
          const unauthorized = e instanceof Ga4ApiError && e.status === 401;
          if (!unauthorized) throw e;
          if (refreshed) throw new ReauthRequired();
          refreshed = true;
          token = await this.token(conn, true);
          report = await pull(dimension).catch((again) => {
            throw again instanceof Ga4ApiError && again.status === 401 ? new ReauthRequired() : again;
          });
        }
        for (const r of report.rows) records.push(this.record(conn, dimension, r, report.currency));
      }

      const dates = [...new Set(records.map((r) => (r.date as Date).toISOString()))].sort().map((d) => new Date(d));
      if (records.length) {
        await this.prisma.$transaction([
          this.prisma.ga4DailyStat.deleteMany({
            where: { workspaceId: conn.workspaceId, propertyId: conn.propertyId, date: { in: dates } },
          }),
          this.prisma.ga4DailyStat.createMany({ data: records }),
        ]);
      }
      await this.prisma.ga4Connection.update({ where: { id: conn.id }, data: { lastSyncedAt: now, lastError: null } });
      return { status: 'synced', rows: records.length };
    } catch (e) {
      if (e instanceof ReauthRequired) {
        this.logger.warn(`GA4 sync for workspace ${conn.workspaceId}: access revoked, reconnect needed`);
        await this.prisma.ga4Connection.update({
          where: { id: conn.id },
          data: { enabled: false, lastError: REAUTH_REQUIRED },
        });
        return { status: 'failed', rows: 0, error: REAUTH_REQUIRED };
      }
      const message = String((e as Error)?.message ?? e).slice(0, 500);
      this.logger.warn(`GA4 sync for workspace ${conn.workspaceId} failed: ${message}`);
      await this.prisma.ga4Connection.update({ where: { id: conn.id }, data: { lastError: message } });
      return { status: 'failed', rows: 0, error: message };
    }
  }

  /** A token, or ReauthRequired when Google will no longer issue one. */
  private async token(conn: Ga4ConnectionRow, forceRefresh = false): Promise<string> {
    try {
      return await this.oauth.accessToken(conn, forceRefresh ? { forceRefresh: true } : undefined);
    } catch (e) {
      if (/invalid_grant/.test(String((e as Error)?.message ?? ''))) throw new ReauthRequired();
      throw e;
    }
  }

  private record(conn: Ga4ConnectionRow, dimension: Ga4Dimension, r: Ga4Row, currency: string | null): Prisma.Ga4DailyStatCreateManyInput {
    return {
      workspaceId: conn.workspaceId,
      propertyId: conn.propertyId!,
      date: new Date(`${r.date}T00:00:00.000Z`),
      dimension,
      key: r.key,
      sessions: Math.round(r.sessions),
      totalUsers: Math.round(r.totalUsers),
      newUsers: Math.round(r.newUsers),
      conversions: Math.round(r.conversions),
      purchaseCount: Math.round(r.purchaseCount),
      purchaseValue: new Prisma.Decimal(r.purchaseValue).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      currency: currency ? currency.slice(0, 3) : null,
    };
  }
}
