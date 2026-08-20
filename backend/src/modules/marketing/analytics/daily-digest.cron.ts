import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { DailyDigestService } from './daily-digest.service';

/** 07:00 server time — before the working day, after the 03:00 research run
 *  has finished, so the brief reports a night that is actually over. */
const DIGEST_CRON = process.env.DAILY_DIGEST_CRON ?? '0 7 * * *';

/**
 * Sends each workspace's morning brief to the people who can act on it.
 *
 * Every other scheduled thing in the product notifies IN-app and per-object:
 * this lead is due, this approval is waiting. None of it reaches someone who
 * is not already looking at the panel, which is exactly the person a
 * self-running system is for. This is the one message that arrives without
 * being asked for.
 *
 * Advisory-locked like the other workspace-fan-out crons: two app instances
 * would otherwise both send, and a duplicate 07:00 email is the fastest way to
 * teach someone to filter it away.
 */
@Injectable()
export class DailyDigestCron {
  private readonly logger = new Logger(DailyDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly digest: DailyDigestService,
    private readonly email: EmailService,
  ) {}

  @Cron(DIGEST_CRON, { name: 'daily-digest' })
  async send(): Promise<{ sent: number; skipped: number }> {
    let outcome = { sent: 0, skipped: 0 };
    await withAdvisoryLock(
      this.prisma,
      'daily-digest',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true },
        });
        let sent = 0;
        let skipped = 0;

        for (const ws of workspaces) {
          try {
            const digest = await this.digest.build(ws.id);
            // Nothing happened and nothing is waiting: staying quiet is the
            // feature. A daily email that is empty most mornings gets filtered,
            // and then the one that matters is filtered with it.
            if (!digest || digest.empty) {
              skipped++;
              continue;
            }
            const to = await this.digest.recipients(ws.id);
            if (!to.length) {
              skipped++;
              continue;
            }
            const body = this.digest.render(digest);
            const subject = `${digest.workspaceName} — günlük özet (${digest.forDate})`;
            for (const address of to) {
              await this.email.sendPlainEmail(address, subject, body);
            }
            sent++;
          } catch (e) {
            // One workspace's failure must not stop the rest of the morning.
            this.logger.warn(`digest failed for ${ws.id}: ${(e as Error)?.message ?? e}`);
            skipped++;
          }
        }
        outcome = { sent, skipped };
        this.logger.log(`daily-digest sent ${sent} workspace brief(s), skipped ${skipped}`);
      },
      this.logger,
    );
    return outcome;
  }
}
