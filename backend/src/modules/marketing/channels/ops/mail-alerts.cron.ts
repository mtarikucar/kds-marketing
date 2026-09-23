import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { MailAlert, MailAlertKind, MailOpsService, breaches } from './mail-ops.service';

/**
 * The bell for the mail that is not going out.
 *
 * `no-email-observability`: the platform SMTP starts answering 535 and nothing
 * pushes. The daily digest already records it into `CronHeartbeat.lastError`,
 * but only an MCP query surfaces that, so the first person to notice is a
 * customer. This is the push half — it raises the same
 * `MarketingNotification` the rest of the product rings, to the people who can
 * act on it.
 *
 * ## The thresholds are the ones Gmail and Yahoo publish
 *
 * Bounce > 5 %, complaint > 0.1 % — not numbers we invented, and not numbers a
 * tenant can raise. Plus the two operational ones: a send failure rate over
 * 20 % on a real sample, and a receive lane that has been down for two hours.
 * They live in `mail-ops.service.ts` as data and are evaluated by a pure
 * function, so this class is a loop and a deduplicator and nothing else.
 *
 * ## Once per breach, never once per row
 *
 * A campaign that bounces four hundred times is ONE thing to go and look at.
 * Every alert is keyed by workspace + kind and re-raised at most once per
 * `RENOTIFY_MS` regardless of whether the last one was read — an unread-only
 * check would go quiet forever the moment somebody clicked the bell, and a
 * per-tick check would bury the bell under the same sentence forty-eight times
 * a day.
 *
 * ## Nothing here throws (G2)
 *
 * One tenant whose snapshot cannot be read must not stop the sweep for the
 * tenants behind it.
 */

/** The notification `type` the bell and the mail-health card both filter on. */
export const MAIL_ALERT_NOTIFICATION = 'MAIL_HEALTH_ALERT';

/** How long an alert of the same kind stays "already said" for one workspace. */
export const RENOTIFY_MS = 12 * 60 * 60 * 1000;

/** The window the rates are measured over. Long enough that one bad minute is
 *  not a reputation verdict, short enough that a breach is still today's news. */
export const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Not a cap — a tripwire. This sweep costs a handful of scoped aggregates per
 * ACTIVE workspace; crossing this many means it needs a narrower candidate
 * query (a mail-activity marker to filter on) rather than a bigger `take`.
 */
const EXPECTED_MAX_WORKSPACES = 500;

/** Turkish fallback copy. The bell renders `metadata.copyKey` when it can (G8);
 *  these are what an un-translated client shows. */
const COPY: Record<MailAlertKind, { title: string; message: (d: Record<string, unknown>) => string }> = {
  SEND_FAILURE_RATE: {
    title: 'E-posta gönderimleri başarısız oluyor',
    message: (d) =>
      `Son 24 saatte ${d.attempted} denemenin ${d.failed} tanesi gönderilemedi. E-posta sağlığı kartına bakın.`,
  },
  BOUNCE_RATE: {
    title: 'Geri dönen e-posta oranı yüksek',
    message: (d) =>
      `Son 24 saatte gönderilen ${d.sent} e-postanın ${d.bounced} tanesi geri döndü (%5 üzeri gönderen itibarınızı düşürür).`,
  },
  COMPLAINT_RATE: {
    title: 'Spam şikâyeti oranı yüksek',
    message: (d) =>
      `Son 24 saatte ${d.complained} alıcı e-postanızı spam olarak işaretledi (%0,1 üzeri gönderen itibarınızı düşürür).`,
  },
  RECEIVE_DOWN: {
    title: 'Posta kutusundan e-posta alınamıyor',
    message: (d) =>
      `"${d.name}" posta kutusu ${d.hours} saattir e-posta alamıyor. Gelen yanıtlar görünmüyor olabilir.`,
  },
  INBOUND_QUARANTINED: {
    title: 'Gelen e-postalar işlenemedi',
    message: (d) => `${d.count} gelen e-posta işlenemedi. Posta kutusu sağlık kartından tekrar deneyebilirsiniz.`,
  },
};

@Injectable()
export class MailAlertsCron {
  private readonly logger = new Logger(MailAlertsCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ops: MailOpsService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'mail-alerts' })
  async tick(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'channels:mail-alerts',
      async () => {
        await this.sweep();
      },
      this.logger,
    );
  }

  async sweep(now: Date = new Date()): Promise<{ workspaces: number; alerts: number; notified: number }> {
    // Cross-workspace by design: a system job. `workspace` is the tenant root
    // and deliberately not a workspace-owned delegate, and every read this
    // sweep then makes is scoped to the id it just read (G5).
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
      take: EXPECTED_MAX_WORKSPACES + 1,
    });
    if (workspaces.length > EXPECTED_MAX_WORKSPACES) {
      this.logger.warn(
        `mail-alerts: ${workspaces.length}+ active workspaces — this sweep needs a narrower candidate query`,
      );
    }

    let alerts = 0;
    let notified = 0;
    for (const ws of workspaces.slice(0, EXPECTED_MAX_WORKSPACES)) {
      try {
        const snapshot = await this.ops.snapshot(ws.id, {
          since: new Date(now.getTime() - ALERT_WINDOW_MS),
          until: now,
        });
        // A workspace the operator has deliberately paused is not a workspace
        // in trouble; alerting on the silence it asked for is how an operator
        // learns to ignore the bell.
        if (snapshot.paused) continue;
        const found = breaches(snapshot, now);
        alerts += found.length;
        for (const alert of found) {
          if (await this.raise(ws.id, alert, now)) notified++;
        }
      } catch (e: any) {
        this.logger.warn(`mail-alerts: workspace=${ws.id} skipped: ${e?.message ?? e}`);
      }
    }
    return { workspaces: workspaces.length, alerts, notified };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** One notification per owner, or none if this alert was already raised
   *  recently. Answers whether it actually said anything. */
  private async raise(workspaceId: string, alert: MailAlert, now: Date): Promise<boolean> {
    try {
      const recent = await this.prisma.marketingNotification.findFirst({
        where: {
          workspaceId,
          type: MAIL_ALERT_NOTIFICATION,
          metadata: { path: ['alert'], equals: alert.kind } as never,
          createdAt: { gte: new Date(now.getTime() - RENOTIFY_MS) },
        },
        select: { id: true },
      });
      if (recent) return false;

      const owners = await this.prisma.workspaceMembership.findMany({
        where: { workspaceId, role: 'OWNER', status: 'ACTIVE' },
        select: { userId: true },
      });
      if (!owners.length) return false;

      const copy = COPY[alert.kind];
      for (const owner of owners) {
        await this.prisma.marketingNotification.create({
          data: {
            workspaceId,
            userId: owner.userId,
            type: MAIL_ALERT_NOTIFICATION,
            title: copy.title,
            message: copy.message(alert.detail).slice(0, 500),
            // `copyKey` is the stable handle the client translates; the literal
            // title/message above are the fallback (G8).
            metadata: { copyKey: `mail.alert.${alert.kind}`, alert: alert.kind, ...alert.detail },
          },
        });
      }
      return true;
    } catch (e: any) {
      this.logger.warn(`mail-alerts: could not raise ${alert.kind} for ${workspaceId}: ${e?.message ?? e}`);
      return false;
    }
  }
}
