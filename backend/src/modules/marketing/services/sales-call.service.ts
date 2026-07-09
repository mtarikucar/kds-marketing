import {
  Injectable,
  Logger,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { TelephonyProviderRegistry } from '../telephony/telephony-provider.registry';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { PrepareCallRequest } from '../telephony/telephony-provider.interface';
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
    private readonly telephonyConfig: TelephonyConfigService,
  ) {}

  /**
   * Reserve the sales line and return a dial URI. Enforces the provider's
   * concurrency: at most `maxConcurrentCalls` may be INITIATED at once —
   * scoped to the whole WORKSPACE for the single-line lite provider
   * (maxConcurrentCalls===1, one shared 0850 number), or scoped PER REP for a
   * multi-line provider like netsantral (maxConcurrentCalls===50) so one
   * busy rep never blocks a teammate's dial on a trunk with capacity to spare
   * (NetGSM Phase 3 Task 6). A stale INITIATED call is auto-cancelled, same
   * scope, so the line/rep never deadlocks on an abandoned row.
   *
   * The provider/registry mechanics stay workspace-agnostic (the telephony
   * line is infrastructure, not tenant data) — but every SalesCall row read
   * or written here is scoped to the actor's workspace.
   */
  async startCall(workspaceId: string, marketingUserId: string, dto: StartCallDto) {
    // Fetch the rep's phone + dahili FIRST — skip the expensive DB+AES resolve
    // when the rep has neither (api-dial is impossible without a leg to ring).
    const rep = await this.prisma.marketingUser.findFirst({
      where: { id: marketingUserId, workspaceId },
      select: { dahili: true, phone: true },
    });

    // Per-workspace provider selection. An ACTIVE Netsantral config lets the call
    // originate from the 0850 trunk; how the rep's leg is rung depends on what's set:
    //  - rep has a phone → 'bridge': NetGSM rings the rep's own phone + the customer
    //    and bridges them (no extension/softphone needed — works without Netsipp).
    //  - else rep has a dahili → 'dahili': rings the extension first (needs a
    //    registered device on it).
    //  - else → click-to-dial fallback (tel: link).
    let providerId = 'netgsm-lite';
    let resolvedConfig: PrepareCallRequest['config'] | undefined;
    if (rep?.phone || rep?.dahili) {
      const netsantral = await this.telephonyConfig.resolveForWorkspace(workspaceId);
      if (netsantral) {
        providerId = 'netgsm-netsantral';
        const base = {
          username: netsantral.username, password: netsantral.password,
          trunk: netsantral.trunk, pbxnum: netsantral.pbxnum,
        };
        resolvedConfig = rep.phone
          ? { ...base, callMode: 'bridge' as const, callerNum: rep.phone }
          : { ...base, callMode: 'dahili' as const, internalNum: rep.dahili ?? undefined };
      }
    }
    const provider = this.registry.get(providerId);

    // Concurrency scope: the single-line lite provider (maxConcurrentCalls===1
    // — one shared company 0850 number) must stay scoped to the WHOLE
    // WORKSPACE, exactly as before. A multi-line provider (netsantral, 50) has
    // capacity PER REP, not per workspace — scoping that check to the whole
    // workspace would let one busy rep's own INITIATED row block every OTHER
    // rep's dial attempt on a trunk that has 49 other lines free (Phase-0
    // finding; NetGSM Phase 3 Task 6). The stale-auto-cancel sweep below is
    // scoped identically, so a rep's own abandoned INITIATED row is only ever
    // cleared against (and only ever counts toward) THEIR OWN limit.
    const perRep = provider.maxConcurrentCalls > 1;

    const active = await this.prisma.salesCall.findMany({
      // workspaceId kept inline (not spread from a variable) so the
      // workspace-scoping arch fitness test can statically see the scope.
      // perRep (multi-line netsantral) also scopes to THIS rep; the single
      // shared-line lite provider stays workspace-wide.
      where: { workspaceId, status: 'INITIATED', ...(perRep ? { marketingUserId } : {}) },
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
        perRep
          ? 'You already have an active call — log or cancel it first'
          : 'Sales line is busy — log or cancel the active call first',
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

    // FIX 1: Create the DB row BEFORE placing the live call so that if origination
    // throws, the row exists and can be marked CANCELLED (no orphaned live calls).
    const created = await this.prisma.salesCall.create({
      data: {
        workspaceId,
        marketingUserId,
        leadId: dto.leadId ?? null,
        direction: 'OUTBOUND',
        toPhone: dto.toPhone,
        providerId,
        status: 'INITIATED',
        externalCallId: null,
      },
    });

    let prepared: Awaited<ReturnType<typeof provider.prepareOutboundCall>>;
    try {
      prepared = await provider.prepareOutboundCall({
        toPhone: dto.toPhone,
        marketingUserId,
        crmId: created.id,
        config: resolvedConfig,
      });
    } catch (err: any) {
      await this.prisma.salesCall.update({
        where: { id: created.id },
        data: {
          status: 'CANCELLED',
          endedAt: new Date(),
          notes: 'Origination failed: ' + (err?.message ?? 'error'),
        },
      });
      throw err;
    }

    if (prepared.externalCallId) {
      await this.prisma.salesCall.update({
        where: { id: created.id },
        data: { externalCallId: prepared.externalCallId },
      });
    }

    const call = { ...created, externalCallId: prepared.externalCallId ?? null };
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
      // Atomic claim INSIDE the tx: only the first logger flips INITIATED→<status>.
      // The pre-check above is racy on its own, so two concurrent logCall calls
      // could both reach here and BOTH mirror a CALL activity. The compound WHERE
      // lets exactly one win; the loser sees count 0 and aborts (no double row).
      const claim = await tx.salesCall.updateMany({
        where: { id, workspaceId, status: 'INITIATED' },
        data: {
          status: dto.status,
          durationSec: dto.durationSec ?? null,
          notes: dto.notes ?? null,
          endedAt: now,
        },
      });
      if (claim.count === 0) {
        throw new ConflictException('Call already logged');
      }
      const row = await tx.salesCall.findUniqueOrThrow({ where: { id } });

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
