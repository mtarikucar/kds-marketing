import {
  Injectable,
  Logger,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { TelephonyProviderRegistry } from '../telephony/telephony-provider.registry';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { StartCallDto } from '../dto/start-call.dto';
import { LogCallDto, SalesCallOutcome } from '../dto/log-call.dto';
import { SalesCallFilterDto } from '../dto/sales-call-filter.dto';
import { MarketingUserPayload } from '../types';
import { paginated } from '../../../common/pagination';

/**
 * Marketing sales-call log over the single company Netgsm line. Phase 2 is
 * click-to-dial + manual logging behind the TelephonyProvider abstraction, so
 * upgrading to Netgsm's API/webhooks later is a registry swap. SalesCall only
 * touches marketing-owned tables (sales_calls, lead_activities, leads) — no
 * core access.
 */
@Injectable()
export class SalesCallService {
  private readonly logger = new Logger(SalesCallService.name);
  /** A call left INITIATED past this is assumed abandoned (rep forgot to log). */
  private static readonly STALE_INITIATED_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TelephonyProviderRegistry,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  private providerId(): string {
    return this.config.get<string>('TELEPHONY_PROVIDER') ?? 'netgsm-lite';
  }

  /**
   * Reserve the sales line and return a dial URI. Enforces the provider's
   * single-line concurrency: at most `maxConcurrentCalls` may be INITIATED at
   * once. A stale INITIATED call is auto-cancelled so the line never deadlocks.
   *
   * The provider/registry mechanics stay workspace-agnostic (the telephony
   * line is infrastructure, not tenant data) — but every SalesCall row read
   * or written here is scoped to the actor's workspace.
   */
  async startCall(workspaceId: string, marketingUserId: string, dto: StartCallDto) {
    const provider = this.registry.get(this.providerId());

    const active = await this.prisma.salesCall.findMany({
      where: { workspaceId, status: 'INITIATED' },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });
    const cutoff = Date.now() - SalesCallService.STALE_INITIATED_MS;
    const stale = active.filter((c) => c.startedAt.getTime() < cutoff);
    if (stale.length) {
      await this.prisma.salesCall.updateMany({
        where: { id: { in: stale.map((c) => c.id) }, workspaceId },
        data: {
          status: 'CANCELLED',
          endedAt: new Date(),
          notes: 'Auto-cancelled (stale — never logged)',
        },
      });
    }
    const liveCount = active.length - stale.length;
    if (liveCount >= provider.maxConcurrentCalls) {
      throw new ConflictException(
        'Sales line is busy — log or cancel the active call first',
      );
    }

    if (dto.leadId) {
      // Scoped read — a lead id from another workspace must not be linkable.
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, workspaceId },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }

    const prepared = await provider.prepareOutboundCall({
      toPhone: dto.toPhone,
      marketingUserId,
    });
    const call = await this.prisma.salesCall.create({
      data: {
        workspaceId,
        marketingUserId,
        leadId: dto.leadId ?? null,
        direction: 'OUTBOUND',
        toPhone: dto.toPhone,
        providerId: prepared.providerId,
        status: 'INITIATED',
        externalCallId: prepared.externalCallId,
      },
    });
    return { call, dialUri: prepared.dialUri, mode: prepared.mode };
  }

  /**
   * Record the outcome of an INITIATED call. Frees the line, mirrors onto the
   * lead timeline (if linked), and emits marketing.call.logged.v1.
   */
  async logCall(workspaceId: string, id: string, marketingUserId: string, dto: LogCallDto) {
    // Scoped pre-check; the update below is keyed by this resolved row. The
    // mirrored leadActivity inherits scope through call.leadId, which was
    // validated against the same workspace at startCall time.
    const call = await this.prisma.salesCall.findFirst({ where: { id, workspaceId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.marketingUserId !== marketingUserId) {
      throw new ForbiddenException('You can only log your own calls');
    }
    if (call.status !== 'INITIATED') {
      throw new ConflictException('Call already logged');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.salesCall.update({
        where: { id },
        data: {
          status: dto.status,
          durationSec: dto.durationSec ?? null,
          notes: dto.notes ?? null,
          endedAt: now,
        },
      });

      // Mirror onto the lead timeline so the rep's call history lives with the
      // lead (duration in minutes, per LeadActivity's convention).
      if (call.leadId) {
        await tx.leadActivity.create({
          data: {
            type: 'CALL',
            title: `Sales call: ${dto.status}`,
            description: dto.notes ?? undefined,
            outcome: this.outcomeFor(dto.status),
            duration: dto.durationSec ? Math.round(dto.durationSec / 60) : undefined,
            leadId: call.leadId,
            createdById: marketingUserId,
          },
        });
      }

      await this.outbox.append(
        {
          type: MarketingEventTypes.CallLogged,
          idempotencyKey: `call-logged:${id}`,
          payload: {
            callId: id,
            marketingUserId,
            leadId: call.leadId,
            status: dto.status,
            durationSec: dto.durationSec ?? null,
            occurredAt: now.toISOString(),
          },
        },
        tx as any,
      );
      return row;
    });

    return updated;
  }

  async list(workspaceId: string, filter: SalesCallFilterDto, user: MarketingUserPayload) {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const filters: Prisma.SalesCallWhereInput = {};

    // Reps see only their own calls; managers may scope to any rep.
    if (user.role === 'REP') {
      filters.marketingUserId = user.id;
    } else if (filter.marketingUserId) {
      filters.marketingUserId = filter.marketingUserId;
    }
    if (filter.leadId) filters.leadId = filter.leadId;
    if (filter.status) filters.status = filter.status;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.salesCall.findMany({
        where: { workspaceId, ...filters },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.salesCall.count({ where: { workspaceId, ...filters } }),
    ]);
    return paginated(data, total, page, limit);
  }

  async get(workspaceId: string, id: string, user: MarketingUserPayload) {
    const call = await this.prisma.salesCall.findFirst({ where: { id, workspaceId } });
    if (!call) throw new NotFoundException('Call not found');
    if (user.role === 'REP' && call.marketingUserId !== user.id) {
      throw new ForbiddenException('You can only view your own calls');
    }
    return call;
  }

  private outcomeFor(status: SalesCallOutcome): string {
    switch (status) {
      case 'CONNECTED':
        return 'POSITIVE';
      case 'NO_ANSWER':
        return 'NO_ANSWER';
      case 'BUSY':
      case 'FAILED':
        return 'NEGATIVE';
      default:
        return 'NEUTRAL';
    }
  }
}
