import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { workspaceLocalParts } from '../../../common/scheduling/workspace-local-day';
import { OutboundMailService } from '../channels/outbound/outbound-mail.service';
import { DailyDigestService } from './daily-digest.service';

/** Local hour each workspace receives its brief. */
const DIGEST_HOUR = Number(process.env.DAILY_DIGEST_HOUR ?? 7);

/** One counter row per workspace per local day — the idempotency key. */
const SENT_METRIC = 'digest.sent';

/**
 * Strip anything shaped like an address out of a provider's own words.
 *
 * The reason string ends up on the cron heartbeat, a PLATFORM row every tenant
 * can read through `jeeta.list_scheduled_runs` — and a real relay quotes the
 * mailbox back inside its rejection ("550 5.1.1 <owner@acme.co> unknown"), so
 * passing the reason through verbatim leaks one workspace's owner address to
 * every other workspace's agent. The actionable half is the code and the text
 * around it, and that survives.
 */
function withoutAddresses(reason: string): string {
  return reason.replace(/<?[^\s<>",;:]+@[^\s<>",;:]+>?/g, '(address)');
}

/**
 * The morning brief, as a product feature rather than a server-time cron.
 *
 * Two things make it multi-tenant rather than "07:00 wherever the server
 * happens to live":
 *
 *  - It ticks HOURLY and sends to each workspace when the clock reads
 *    DIGEST_HOUR in ITS OWN timezone. A brief that lands at 04:00 for an
 *    Istanbul customer because the box runs UTC is not a morning brief.
 *  - Any workspace can switch it off in `settings.dailyDigest.enabled`.
 *    Defaulting to ON is deliberate — a self-running system that never tells
 *    you what it did is the failure mode this exists to prevent — but a daily
 *    email nobody can stop is spam, however well-intentioned.
 *
 * Idempotent by construction: the send is claimed by CREATING a UsageCounter
 * row keyed on the workspace's LOCAL date, so a restart inside the same hour,
 * or a second app instance, finds the row taken and stays quiet. The advisory
 * lock stops the fan-outs overlapping; this stops the same day being sent
 * twice, which the lock alone cannot.
 */
@Injectable()
export class DailyDigestCron {
  private readonly logger = new Logger(DailyDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly digest: DailyDigestService,
    private readonly mail: OutboundMailService,
  ) {}

  /** Local wall-clock parts for a workspace, via the Intl database. Kept as a
   *  static (callers and tests reach for it here) but the implementation now
   *  lives in common/scheduling so the strategy-apply tick shares ONE
   *  workspace-timezone reading rather than a second copy of it. */
  static localParts(timezone: string, now = new Date()): { hour: number; date: string } {
    return workspaceLocalParts(timezone, now);
  }

  private enabled(settings: unknown): boolean {
    const s = settings as { dailyDigest?: { enabled?: boolean } } | null;
    return s?.dailyDigest?.enabled !== false;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'daily-digest' })
  async tick(): Promise<{ sent: number; skipped: number }> {
    let outcome = { sent: 0, skipped: 0 };
    // Caught here, NOT inside the lock. withAdvisoryLock records the failure on
    // the job's heartbeat before rethrowing, so the error still reaches the one
    // surface that can report it; swallowing it here only stops a cron tick
    // from ending in an unhandled rejection.
    try {
      await withAdvisoryLock(
      this.prisma,
      'daily-digest',
      async () => {
        const workspaces = await this.prisma.workspace.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, timezone: true, settings: true },
        });
        let sent = 0;
        let skipped = 0;
        const undelivered: string[] = [];

        for (const ws of workspaces) {
          try {
            const { hour, date } = DailyDigestCron.localParts(ws.timezone);
            if (hour !== DIGEST_HOUR || !this.enabled(ws.settings)) continue;

            // Claim the day BEFORE building: if the send later fails, the day
            // stays claimed and we do not retry hourly into someone's inbox.
            try {
              await this.prisma.usageCounter.create({
                data: { workspaceId: ws.id, metric: SENT_METRIC, periodKey: date, value: 1 },
              });
            } catch (e) {
              if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
              throw e;
            }

            const digest = await this.digest.build(ws.id);
            // Nothing happened and nothing is waiting: staying quiet is the
            // feature. A daily email that is empty most mornings gets filtered,
            // and the mornings that matter get filtered with it.
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
              // INTERNAL: our own users, about our own product. That class is
              // what keeps an unsubscribe header off an account-service mail,
              // keeps a tenant Reply-To off it, and keeps it OUT of the
              // messagesMonthly meter the tenant pays for (§A1).
              //
              // Before the gateway this was `sendPlainEmail`, whose bare `true`
              // meant both "delivered" and "no transporter configured, logged
              // an [EMAIL MOCK] line" — so an inert deploy reported a
              // successful send every morning forever. The receipt separates
              // the two, and NOT_CONFIGURED now arrives as a reason rather than
              // as a silent success.
              const receipt = await this.mail.send({
                workspaceId: ws.id,
                mailClass: 'INTERNAL',
                to: address,
                subject,
                text: body,
                source: 'digest',
              });
              if (!receipt.ok) {
                // Carry the reason, not just the fact. "Undelivered" tells the
                // owner to look; "535 authentication failed" tells them what to
                // fix. The provider's own words first, the machine code when it
                // had none — and neither one carrying anybody's address.
                const why = receipt.error || receipt.reason || '';
                undelivered.push(why ? withoutAddresses(why) : '(no reason reported)');
              }
            }
            sent++;
          } catch (e) {
            // One workspace's failure must not stop the rest of the morning.
            this.logger.warn(`digest failed for ${ws.id}: ${(e as Error)?.message ?? e}`);
            skipped++;
          }
        }
        outcome = { sent, skipped };
        if (sent || skipped) {
          this.logger.log(`daily-digest sent ${sent} brief(s), skipped ${skipped}`);
        }

        // Thrown AFTER the loop, deliberately: one workspace's mail failure must
        // not cost the others their morning, but the run itself is not a success
        // and must not read as one. withAdvisoryLock records the error on the
        // job's heartbeat, which is readable — so the brief that could not
        // announce its own failure announces it there instead.
        if (undelivered.length) {
          // Distinct reasons, not one line per recipient: five bounces from one
          // dead mailbox are one problem, and de-duplicating keeps the count
          // honest while the text stays short enough to survive truncation.
          const reasons = [...new Set(undelivered)];
          throw new Error(
            `digest undelivered for ${undelivered.length} recipient(s): ${reasons.slice(0, 3).join(' | ')}`,
          );
        }
        },
        this.logger,
      );
    } catch (e) {
      this.logger.error(`daily-digest: ${(e as Error)?.message ?? e}`);
    }
    return outcome;
  }
}
