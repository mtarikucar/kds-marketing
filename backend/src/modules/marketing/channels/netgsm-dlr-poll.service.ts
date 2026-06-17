import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { NetgsmReportClient } from './netgsm-report.client';
import { mapNetgsmDlr } from './netgsm-dlr.util';

/**
 * Polls NetGSM delivery reports (NetGSM does NOT push them). Once a minute,
 * advisory-locked (single replica), it queries the report API for recently-sent
 * SMS still in SENT status and applies the mapped terminal status.
 *
 * Selection is per-workspace and writes are by message id, so this system cron
 * never addresses rows cross-tenant (mirrors the offer-expire sweeper). Report
 * calls are bounded per tick by NetGSM's ≤10/min report limit. Campaign blasts
 * persist no Message rows, so this covers 1:1 conversation sends — the two-way
 * customer-service delivery confirmation the integration is for.
 */
@Injectable()
export class NetgsmDlrPollService {
  private readonly logger = new Logger(NetgsmDlrPollService.name);

  /** Only poll sends from the recent past; older ones age out (no report kept). */
  private static readonly WINDOW_HOURS = 72;
  /** NetGSM caps report queries at ≤10/min — bound work per tick accordingly. */
  private static readonly MAX_REPORTS_PER_TICK = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly report: NetgsmReportClient,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'netgsm-dlr-poll' })
  async pollDueReports(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'netgsm-dlr-poll',
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<{ polled: number; updated: number }> {
    const since = new Date(Date.now() - NetgsmDlrPollService.WINDOW_HOURS * 3_600_000);
    let budget = NetgsmDlrPollService.MAX_REPORTS_PER_TICK;
    let polled = 0;
    let updated = 0;

    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    for (const ws of workspaces) {
      if (budget <= 0) break;

      const channels = await this.prisma.channel.findMany({
        where: { workspaceId: ws.id, type: 'SMS', status: 'ACTIVE' },
      });
      if (channels.length === 0) continue;

      const credsByChannel = new Map<string, Record<string, string>>();
      for (const ch of channels) credsByChannel.set(ch.id, this.registry.resolveConfig(ch).secrets);
      const channelIds = channels.map((c) => c.id);

      // Conversations touched within the window bound the message scan without a
      // channelId on Message: any conversation holding a recent outbound SMS has
      // lastMessageAt >= that message's createdAt, so this is a correct superset.
      const convos = await this.prisma.conversation.findMany({
        where: { workspaceId: ws.id, channelId: { in: channelIds }, lastMessageAt: { gte: since } },
        select: { id: true, channelId: true },
      });
      if (convos.length === 0) continue;
      const convoToChannel = new Map(convos.map((c) => [c.id, c.channelId]));

      const candidates = await this.prisma.message.findMany({
        where: {
          workspaceId: ws.id,
          conversationId: { in: convos.map((c) => c.id) },
          direction: 'OUTBOUND',
          status: 'SENT',
          externalMessageId: { not: null },
          createdAt: { gte: since },
        },
        select: { id: true, externalMessageId: true, conversationId: true },
        orderBy: { createdAt: 'asc' },
        take: budget,
      });

      for (const msg of candidates) {
        if (budget <= 0) break;
        const channelId = convoToChannel.get(msg.conversationId);
        const creds = channelId ? credsByChannel.get(channelId) : undefined;
        if (!creds?.usercode || !creds?.password || !msg.externalMessageId) continue;

        budget--;
        polled++;
        let row;
        try {
          row = await this.report.fetchStatus(
            { usercode: creds.usercode, password: creds.password },
            msg.externalMessageId,
          );
        } catch (e: any) {
          this.logger.warn(
            `netgsm report fetch failed for bulkid=${msg.externalMessageId}: ${e?.message ?? e}`,
          );
          continue;
        }
        if (!row) continue;

        const mapping = mapNetgsmDlr(row.durumcode, row.hatakod ?? undefined);
        if (!mapping.terminal) continue;

        await this.prisma.message.update({
          where: { id: msg.id },
          data: { status: mapping.status, error: mapping.reason },
        });
        updated++;
      }
    }

    if (updated > 0) {
      this.logger.log(`netgsm-dlr-poll: updated ${updated} of ${polled} polled report(s)`);
    }
    return { polled, updated };
  }
}
