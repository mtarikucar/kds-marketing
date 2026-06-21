import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { InvoicesService } from '../invoicing/invoices.service';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from '../dto/subscription.dto';

interface SubItem {
  description: string;
  qty: number;
  unitPrice: number;
}

/**
 * Recurring customer subscriptions (GoHighLevel parity). CRUD + pause/resume/
 * cancel, plus billOne() — the per-row work the hourly scheduler invokes to mint
 * a DRAFT invoice for a due period. Invoice math is NOT duplicated: it reuses
 * InvoicesService.create. Idempotency is belt-and-suspenders: a per-period
 * pre-check here + the DB partial-unique index on (subscriptionId,
 * subscriptionPeriodKey), so no period is ever billed twice.
 *
 * Workspace-owned: every multi-row/create query inlines `workspaceId`
 * (billOne's pre-check included); id-keyed update/delete go through a scoped read
 * or carry a row resolved from a scoped sweep. The scheduler's cross-workspace
 * due-row sweep lives in SubscriptionsSchedulerService (the one global reader).
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
  ) {}

  private computeAmount(items: SubItem[]): number {
    return (items ?? []).reduce(
      (sum, it) =>
        sum +
        Math.max(0, Math.round(Number(it.qty) || 0)) *
          Math.max(0, Math.round(Number(it.unitPrice) || 0)),
      0,
    );
  }

  // ─── Period math (UTC, deterministic) ──────────────────────────────────────

  periodKeyFor(interval: string, from: Date): string {
    const y = from.getUTCFullYear();
    if (interval === 'YEAR') return `${y}`;
    if (interval === 'WEEK') return `${y}-W${String(this.isoWeek(from)).padStart(2, '0')}`;
    return `${y}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`; // MONTH
  }

  addInterval(d: Date, interval: string, count: number): Date {
    const x = new Date(d);
    const n = Math.max(1, count);
    if (interval === 'WEEK') {
      x.setUTCDate(x.getUTCDate() + 7 * n);
      return x;
    }
    // MONTH / YEAR add the unit but must CLAMP the day — JS setUTCMonth/Year do
    // NOT clamp (Jan-31 + 1mo would overflow to Mar-3). If the day overflowed
    // into the next month, pull back to the last day of the intended month
    // (setUTCDate(0) = last day of the previous month).
    const day = x.getUTCDate();
    if (interval === 'YEAR') x.setUTCFullYear(x.getUTCFullYear() + n);
    else x.setUTCMonth(x.getUTCMonth() + n);
    if (x.getUTCDate() < day) x.setUTCDate(0);
    return x;
  }

  private isoWeek(d: Date): number {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    return (
      1 +
      Math.round(
        (date.getTime() - firstThursday.getTime()) / 86_400_000 / 7,
      )
    );
  }

  /** Roll a schedule forward to the first boundary strictly after `now`. */
  private advanceUntilFuture(
    sub: { nextBillingAt: Date; interval: string; intervalCount: number },
    now: Date,
  ): Date {
    let next = new Date(sub.nextBillingAt);
    let guard = 0;
    while (next <= now && guard++ < 1000) {
      next = this.addInterval(next, sub.interval, sub.intervalCount);
    }
    return next;
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  list(workspaceId: string) {
    return this.prisma.customerSubscription.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        name: true,
        leadId: true,
        amount: true,
        currency: true,
        interval: true,
        intervalCount: true,
        status: true,
        nextBillingAt: true,
        lastBilledAt: true,
        invoicesGenerated: true,
        createdAt: true,
      },
    });
  }

  async get(workspaceId: string, id: string) {
    const sub = await this.prisma.customerSubscription.findFirst({ where: { id, workspaceId } });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  // ─── Create / update ───────────────────────────────────────────────────────

  async create(workspaceId: string, dto: CreateSubscriptionDto) {
    const items = (dto.items ?? []) as SubItem[];
    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, workspaceId },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }
    const anchor = dto.startAt ? new Date(dto.startAt) : new Date();
    return this.prisma.customerSubscription.create({
      data: {
        workspaceId,
        leadId: dto.leadId ?? null,
        name: dto.name,
        items: items as unknown as Prisma.InputJsonValue,
        currency: (dto.currency ?? 'TRY').toUpperCase(),
        amount: this.computeAmount(items),
        notes: dto.notes ?? null,
        dueDays: dto.dueDays ?? 14,
        interval: dto.interval ?? 'MONTH',
        intervalCount: dto.intervalCount ?? 1,
        anchorAt: anchor,
        nextBillingAt: anchor, // first invoice mints on/after the anchor
        status: 'ACTIVE',
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateSubscriptionDto) {
    const sub = await this.get(workspaceId, id);
    if (sub.status === 'CANCELLED') {
      throw new BadRequestException('A cancelled subscription cannot be edited');
    }
    const data: Prisma.CustomerSubscriptionUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.dueDays !== undefined) data.dueDays = dto.dueDays;
    if (dto.currency !== undefined) data.currency = dto.currency.toUpperCase();
    if (dto.interval !== undefined) data.interval = dto.interval;
    if (dto.intervalCount !== undefined) data.intervalCount = dto.intervalCount;
    if (dto.items !== undefined) {
      const items = dto.items as SubItem[];
      data.items = items as unknown as Prisma.InputJsonValue;
      data.amount = this.computeAmount(items);
    }
    // An operator edit clears the poison-pill guard so a previously-failing row
    // is swept again next tick.
    data.failedAttempts = 0;
    return this.prisma.customerSubscription.update({ where: { id: sub.id }, data });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async pause(workspaceId: string, id: string) {
    const sub = await this.get(workspaceId, id);
    if (sub.status !== 'ACTIVE') {
      throw new BadRequestException('Only an active subscription can be paused');
    }
    return this.prisma.customerSubscription.update({
      where: { id: sub.id },
      data: { status: 'PAUSED' },
    });
  }

  async resume(workspaceId: string, id: string) {
    const sub = await this.get(workspaceId, id);
    if (sub.status !== 'PAUSED') {
      throw new BadRequestException('Only a paused subscription can be resumed');
    }
    // Roll past any periods skipped while paused so resume bills the CURRENT
    // period, not a burst of back-dated invoices.
    const next = this.advanceUntilFuture(sub, new Date());
    return this.prisma.customerSubscription.update({
      where: { id: sub.id },
      data: { status: 'ACTIVE', nextBillingAt: next, failedAttempts: 0 },
    });
  }

  async cancel(workspaceId: string, id: string) {
    const sub = await this.get(workspaceId, id);
    return this.prisma.customerSubscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELLED' },
    });
  }

  // ─── Billing (invoked per due row by the scheduler) ─────────────────────────

  /**
   * Mint a DRAFT invoice for the subscription's current due period and advance
   * the schedule. Idempotent: a per-period pre-check + the partial-unique index
   * guarantee at most one invoice per (subscription, period). Returns 'skipped'
   * when the period was already invoiced (heals by advancing without re-minting).
   */
  async billOne(
    sub: {
      id: string;
      workspaceId: string;
      leadId: string | null;
      name: string;
      items: unknown;
      currency: string;
      notes: string | null;
      dueDays: number;
      interval: string;
      intervalCount: number;
      nextBillingAt: Date;
    },
    now: Date = new Date(),
  ): Promise<'billed' | 'skipped'> {
    const periodKey = this.periodKeyFor(sub.interval, sub.nextBillingAt);

    const advance = (extra: Prisma.CustomerSubscriptionUpdateInput = {}) =>
      this.prisma.customerSubscription.update({
        where: { id: sub.id },
        data: {
          nextBillingAt: this.addInterval(sub.nextBillingAt, sub.interval, sub.intervalCount),
          lastBilledPeriodKey: periodKey,
          ...extra,
        },
      });

    // Belt (optimisation): skip the create round-trip if already billed.
    const existing = await this.prisma.invoice.findFirst({
      where: { workspaceId: sub.workspaceId, subscriptionId: sub.id, subscriptionPeriodKey: periodKey },
      select: { id: true },
    });
    if (existing) {
      await advance({ failedAttempts: 0 });
      return 'skipped';
    }

    const dueDate = new Date(now.getTime() + sub.dueDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    try {
      // The invoice is born already STAMPED with (subscriptionId, periodKey), so
      // the partial-unique index enforces one-invoice-per-period AT INSERT —
      // there is NO unstamped-orphan window. A concurrent duplicate throws P2002
      // (caught → advance-and-skip). A transient DB error bubbles to the
      // scheduler, which bumps failedAttempts and does NOT advance (bounded retry).
      await this.invoices.create(sub.workspaceId, {
        leadId: sub.leadId ?? undefined,
        items: sub.items as SubItem[],
        currency: sub.currency,
        notes: sub.notes ?? `${sub.name} — ${periodKey}`,
        dueDate,
        subscriptionId: sub.id,
        subscriptionPeriodKey: periodKey,
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        await advance({ failedAttempts: 0 });
        return 'skipped';
      }
      throw e;
    }

    await advance({ lastBilledAt: now, invoicesGenerated: { increment: 1 }, failedAttempts: 0 });
    return 'billed';
  }
}
