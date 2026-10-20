import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { isGoogleOAuthConfigured } from '../../../../common/util/google-oauth-env';
import { isSecretBoxConfigured } from '../../../../common/crypto/secret-box.helper';
import { ga4SyncEnabled } from './ga4.flag';
import { Ga4SyncService } from './ga4-sync.service';

/** A connection is due once a day; the hourly tick spreads them out. */
const DUE_AFTER_MS = 20 * 60 * 60 * 1000;
const BATCH = 20;

export interface Ga4CronResult {
  ran: boolean;
  connections: number;
  synced: number;
  failed: number;
}

/**
 * Hourly at :15 (contract §6.3): every enabled connection with a property that
 * has not synced in 20 hours, oldest first, 20 per tick, under one advisory
 * lock so two replicas never pull the same property twice. Inert unless the
 * flag, the Google OAuth client and the secret box are all present.
 */
@Injectable()
export class Ga4SyncCron {
  private readonly logger = new Logger(Ga4SyncCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: Ga4SyncService,
  ) {}

  @Cron('0 15 * * * *', { name: 'ga4-daily-sync' })
  async tick(): Promise<void> {
    await this.runDue(new Date());
  }

  async runDue(now: Date): Promise<Ga4CronResult> {
    const result: Ga4CronResult = { ran: false, connections: 0, synced: 0, failed: 0 };
    if (!ga4SyncEnabled() || !isGoogleOAuthConfigured() || !isSecretBoxConfigured()) return result;

    await withAdvisoryLock(
      this.prisma,
      'ga4:daily-sync',
      async () => {
        result.ran = true;
        const due = await this.prisma.ga4Connection.findMany({
          where: {
            enabled: true,
            propertyId: { not: null },
            OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - DUE_AFTER_MS) } }],
          },
          orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
          take: BATCH,
        });
        result.connections = due.length;
        for (const conn of due) {
          try {
            const out = await this.sync.syncConnection(conn, now);
            if (out.status === 'failed') result.failed++;
            else result.synced++;
          } catch (e) {
            result.failed++;
            this.logger.warn(`GA4 sync crashed for connection ${conn.id}: ${(e as Error)?.message ?? e}`);
          }
        }
      },
      this.logger,
    );
    return result;
  }
}
