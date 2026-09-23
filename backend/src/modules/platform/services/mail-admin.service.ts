import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { emailPaused } from '../../../common/util/email-paused';
import { MailBudgetService } from '../../marketing/channels/outbound/mail-budget.service';
import {
  InertMailFeature,
  inertMailFeatures,
} from '../../marketing/channels/ops/mail-ops.service';
import {
  MailboxHealth,
  readMailboxHealth,
} from '../../marketing/channels/mailbox-health.service';

/**
 * The platform console's E-posta panel: every tenant's day on one screen, plus
 * the switch that stops one of them.
 *
 * ## Why this is not `MailOpsService` in a loop
 *
 * That service is per tenant and deliberately so — `mailLog` and
 * `emailInboundItem` are workspace-owned delegates and every read it makes
 * names a workspace, which is what `workspace-scoping.arch.spec.ts` enforces
 * inside `modules/marketing`. Running it once per tenant would be a dozen
 * queries each, thirty times over, to fill one table. The operator realm is
 * the ONE place a cross-tenant aggregate is legitimate, so the console's four
 * grouped reads live here instead of buying a standing `ALLOWED_GLOBAL`
 * exemption in the tenant module (PLAN G5).
 *
 * ## What it answers
 *
 * `shared-godaddy-mailbox` / `no-per-tenant-control`: a single relay carries
 * every tenant's fallback mail, and when it throttles the operator had no way
 * to tell whose blast caused it. So: today's platform-transport count per
 * tenant against both ceilings, busiest first; how many mailboxes each has and
 * how many are actually proven; the newest mailbox error in the clear; the
 * standing quarantine; and the list of env-gated features this deployment
 * leaves inert.
 *
 * ## Nothing here throws on a read (G2)
 *
 * A console that 500s during an outage is unavailable exactly when it matters.
 * `setPaused` is the exception: a write the operator asked for must say so
 * when it did not happen.
 */

export interface PlatformMailWorkspace {
  workspaceId: string;
  name: string;
  status: string;
  /** `settings.email.paused` — the operator switch below. */
  paused: boolean;
  /** Today's PLATFORM-transport sends. A tenant on its own mailbox spends its
   *  own provider's quota and is deliberately not counted here. */
  used: number;
  cap: number;
  sent: number;
  failed: number;
  refused: number;
  bounced: number;
  mailboxes: number;
  provenMailboxes: number;
  quarantined: number;
  lastError: {
    channelId: string;
    name: string;
    lane: 'send' | 'receive';
    reason?: string;
    error?: string;
    at?: string;
  } | null;
}

export interface PlatformMailOverview {
  day: string;
  platform: { limit: number; used: number };
  workspaces: PlatformMailWorkspace[];
  inert: InertMailFeature[];
  /** At least one grouped read could not be answered; the numbers understate. */
  partial: boolean;
}

/** An operator console lists tenants; a deployment past this needs paging. */
const MAX_WORKSPACES = 500;

@Injectable()
export class MailAdminService {
  private readonly logger = new Logger(MailAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: MailBudgetService,
  ) {}

  async overview(
    opts: { now?: Date; env?: Record<string, string | undefined> } = {},
  ): Promise<PlatformMailOverview> {
    const now = opts.now ?? new Date();
    const dayStart = startOfUtcDay(now);
    const failures: string[] = [];

    const workspaces =
      (await this.guard(failures, 'workspaces', () =>
        this.prisma.workspace.findMany({
          // CLOSED tenants are gone; SUSPENDED ones are exactly the interesting
          // case (mail is being refused and somebody will ask why).
          where: { status: { not: 'CLOSED' } },
          select: { id: true, name: true, status: true, settings: true },
          take: MAX_WORKSPACES,
        }),
      )) ?? [];
    const ids = workspaces.map((w) => w.id);

    const [platform, breakdown, byStatus, bounced, channels, quarantined] = await Promise.all([
      this.guard(failures, 'platform', () => this.budget.platformUsage(now)),
      this.guard(failures, 'breakdown', () => this.budget.breakdown(ids, now)),
      this.guard(failures, 'byStatus', () =>
        this.prisma.mailLog.groupBy({
          by: ['workspaceId', 'status'],
          where: { createdAt: { gte: dayStart } },
          _count: { _all: true },
        }),
      ),
      this.guard(failures, 'bounced', () =>
        this.prisma.mailLog.groupBy({
          by: ['workspaceId'],
          where: { createdAt: { gte: dayStart }, bouncedAt: { not: null } },
          _count: { _all: true },
        }),
      ),
      this.guard(failures, 'channels', () =>
        this.prisma.channel.findMany({
          where: { type: 'EMAIL' },
          select: {
            id: true,
            workspaceId: true,
            name: true,
            lastVerifiedAt: true,
            configPublic: true,
          },
        }),
      ),
      this.guard(failures, 'quarantined', () =>
        this.prisma.emailInboundItem.groupBy({
          by: ['workspaceId'],
          where: { state: 'QUARANTINED' },
          _count: { _all: true },
        }),
      ),
    ]);

    const cap = this.budget.caps().workspace;
    const usedBy = new Map((breakdown ?? []).map((r) => [r.workspaceId, r.used]));
    const bouncedBy = tally(bounced ?? []);
    const parkedBy = tally(quarantined ?? []);
    const statusBy = new Map<string, Record<string, number>>();
    for (const row of byStatus ?? []) {
      const cell = (statusBy.get(row.workspaceId) ?? {}) as Record<string, number>;
      cell[String((row as any).status)] = countOf(row);
      statusBy.set(row.workspaceId, cell);
    }
    const mailboxesBy = this.groupMailboxes(channels ?? []);

    const rows: PlatformMailWorkspace[] = workspaces.map((ws) => {
      const s = statusBy.get(ws.id) ?? {};
      const box = mailboxesBy.get(ws.id);
      return {
        workspaceId: ws.id,
        name: ws.name,
        status: ws.status,
        paused: emailPaused(ws.settings),
        used: usedBy.get(ws.id) ?? 0,
        cap,
        sent: s.SENT ?? 0,
        failed: (s.FAILED_PERMANENT ?? 0) + (s.FAILED_TRANSIENT ?? 0),
        refused: s.REFUSED ?? 0,
        bounced: bouncedBy.get(ws.id) ?? 0,
        mailboxes: box?.total ?? 0,
        provenMailboxes: box?.proven ?? 0,
        quarantined: parkedBy.get(ws.id) ?? 0,
        lastError: box?.lastError ?? null,
      };
    });

    // Busiest first: the panel exists to answer "whose blast was it", and a
    // tenant sending nothing is not the one being looked for.
    rows.sort((a, b) => b.used - a.used || b.sent - a.sent || a.name.localeCompare(b.name));

    return {
      day: platform?.day ?? startOfUtcDay(now).toISOString().slice(0, 10),
      platform: { limit: platform?.limit ?? 0, used: platform?.used ?? 0 },
      workspaces: rows,
      inert: inertMailFeatures(opts.env ?? process.env),
      partial: failures.length > 0,
    };
  }

  /**
   * The kill switch: stop (or resume) every metered mail for one tenant.
   *
   * Two readers enforce it, both through `common/util/email-paused`:
   * `MailGuardService` on the TRANSACTIONAL/BULK gates, and
   * `MessageSenderService` on the CONVERSATIONAL lane, which deliberately does
   * not go through the gateway — so the AI reply engine and the Inbox composer
   * stop too. That is the whole feature: one merged write into free-shape
   * settings. It re-reads first because
   * `settings` is a platform-PATCHable blob: writing back a copy read minutes
   * earlier is how an operator's pause silently reverts a tenant's branding.
   */
  async setPaused(workspaceId: string, paused: boolean): Promise<{ workspaceId: string; paused: boolean }> {
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { settings: true },
    });
    if (!ws) throw new NotFoundException('Workspace not found');

    const settings =
      ws.settings && typeof ws.settings === 'object' ? { ...(ws.settings as Record<string, unknown>) } : {};
    const email =
      settings.email && typeof settings.email === 'object'
        ? { ...(settings.email as Record<string, unknown>) }
        : {};
    settings.email = { ...email, paused };

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { settings: settings as Prisma.InputJsonValue },
    });
    this.logger.log(`mail sending ${paused ? 'PAUSED' : 'resumed'} for workspace ${workspaceId}`);
    return { workspaceId, paused };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async guard<T>(failures: string[], what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (e: any) {
      failures.push(what);
      this.logger.warn(`mail admin ${what} read failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Per tenant: how many mailboxes, how many proven, and the newest error on
   *  either lane. `configPublic` is plaintext by design — the sealed box has
   *  nothing an operator could filter or read (see MailboxHealthService). */
  private groupMailboxes(channels: any[]): Map<string, {
    total: number;
    proven: number;
    lastError: PlatformMailWorkspace['lastError'];
  }> {
    const out = new Map<string, { total: number; proven: number; lastError: PlatformMailWorkspace['lastError'] }>();
    for (const c of channels) {
      const cell = out.get(c.workspaceId) ?? { total: 0, proven: 0, lastError: null };
      cell.total++;
      if (c.lastVerifiedAt) cell.proven++;
      const health: MailboxHealth = readMailboxHealth(c.configPublic);
      for (const lane of ['send', 'receive'] as const) {
        const l = health[lane];
        if (!l || l.ok !== false) continue;
        const candidate = {
          channelId: c.id,
          name: c.name ?? '',
          lane,
          ...(l.reason ? { reason: l.reason } : {}),
          ...(l.lastError ? { error: l.lastError } : {}),
          ...(l.lastErrorAt ? { at: l.lastErrorAt } : {}),
        };
        if (!cell.lastError || (candidate.at ?? '') > (cell.lastError.at ?? '')) {
          cell.lastError = candidate;
        }
      }
      out.set(c.workspaceId, cell);
    }
    return out;
  }
}

function countOf(row: any): number {
  return Number(row?._count?._all ?? row?._count ?? 0) || 0;
}

function tally(rows: any[]): Map<string, number> {
  return new Map(rows.map((r) => [String(r.workspaceId), countOf(r)]));
}

function startOfUtcDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
