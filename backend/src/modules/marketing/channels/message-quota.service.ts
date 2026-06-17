import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { monthKey } from '../ai/ai-credits.service';

export const MESSAGES_METRIC = 'messages.sent';

function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/**
 * Monthly outbound-message metering — the exact reserve/refund pattern as
 * AiCreditsService, against the `messagesMonthly` limit. Web-chat is free
 * (the caller skips the reserve for WEBCHAT sends); every other channel
 * (WhatsApp/SMS/Instagram/Messenger) costs one message. reserve() BEFORE the
 * adapter.send (throws MESSAGES_EXHAUSTED at the cap); refund() if the send
 * then fails so a customer isn't metered for an undelivered message.
 */
@Injectable()
export class MessageQuotaService {
  private readonly logger = new Logger(MessageQuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Web-chat is free + unmetered; everything else consumes the monthly pool. */
  isMetered(channelType: string): boolean {
    return channelType !== 'WEBCHAT';
  }

  async reserve(workspaceId: string, channelType: string, count = 1): Promise<void> {
    if (!this.isMetered(channelType) || count <= 0) return;
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.messagesMonthly;
    const period = monthKey();

    if (limit === -1) {
      await this.bump(workspaceId, period, count);
      return;
    }
    if (limit === 0) {
      throw new ForbiddenException({
        code: 'MESSAGES_EXHAUSTED',
        message: 'Outbound messages are not included in your plan',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('messages:' + workspaceId)}))::text AS locked`,
      );
      const row = await tx.usageCounter.findUnique({
        where: {
          workspaceId_metric_periodKey: {
            workspaceId,
            metric: MESSAGES_METRIC,
            periodKey: period,
          },
        },
        select: { value: true },
      });
      const used = row?.value ?? 0;
      if (used + count > limit) {
        throw new ForbiddenException({
          code: 'MESSAGES_EXHAUSTED',
          message: `Monthly message limit reached (${limit})`,
        });
      }
      await tx.usageCounter.upsert({
        where: {
          workspaceId_metric_periodKey: {
            workspaceId,
            metric: MESSAGES_METRIC,
            periodKey: period,
          },
        },
        create: { workspaceId, metric: MESSAGES_METRIC, periodKey: period, value: count },
        update: { value: { increment: count } },
      });
    });
  }

  async refund(workspaceId: string, channelType: string, count = 1): Promise<void> {
    if (!this.isMetered(channelType) || count <= 0) return;
    const period = monthKey();
    // Floored read-modify-write under the SAME per-workspace lock as reserve, so
    // a refund can never drive the counter below 0 (a negative `used` would make
    // `remaining` overstate the cap and let a workspace exceed its plan).
    await this.prisma
      .$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('messages:' + workspaceId)}))::text AS locked`,
        );
        const row = await tx.usageCounter.findUnique({
          where: { workspaceId_metric_periodKey: { workspaceId, metric: MESSAGES_METRIC, periodKey: period } },
          select: { value: true },
        });
        if (!row) return; // nothing reserved this period → nothing to refund
        const next = Math.max(0, (row.value ?? 0) - count);
        await tx.usageCounter.update({
          where: { workspaceId_metric_periodKey: { workspaceId, metric: MESSAGES_METRIC, periodKey: period } },
          data: { value: next },
        });
      })
      .catch((e: any) =>
        this.logger.error(`message refund failed for ${workspaceId}: ${e?.message ?? e}`),
      );
  }

  async usage(workspaceId: string): Promise<{ limit: number; used: number; remaining: number }> {
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.messagesMonthly;
    const row = await this.prisma.usageCounter.findUnique({
      where: {
        workspaceId_metric_periodKey: {
          workspaceId,
          metric: MESSAGES_METRIC,
          periodKey: monthKey(),
        },
      },
      select: { value: true },
    });
    const used = row?.value ?? 0;
    return { limit, used, remaining: limit === -1 ? -1 : Math.max(0, limit - used) };
  }

  private async bump(workspaceId: string, periodKey: string, delta: number): Promise<void> {
    await this.prisma.usageCounter.upsert({
      where: {
        workspaceId_metric_periodKey: { workspaceId, metric: MESSAGES_METRIC, periodKey },
      },
      create: {
        workspaceId,
        metric: MESSAGES_METRIC,
        periodKey,
        value: Math.max(0, delta),
      },
      update: { value: { increment: delta } },
    });
  }
}
