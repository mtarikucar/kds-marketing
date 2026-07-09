import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { AutocallClient } from '../../netgsm/voice/autocall.client';
import { IysClient, IysSearchResult } from '../../netgsm/iys/iys.client';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { netgsmWebhookUrl } from '../../netgsm/webhooks/netgsm-webhook.util';
import { toIysMsisdn } from '../utils/lead-normalize';
import { StartAutocallSessionDto } from '../dto/autocall-dialer.dto';

export const AUTOCALL_STREAM_KIND = 'autocall.stream';

/** Mirrors DialerService.DIAL_QUEUE_CAP — a focused calling sprint, not a dump. */
const MAX_QUEUE = 100;
/** Numbers streamed per tick — sized to fit the account's 10/min autocall budget. */
const STREAM_BATCH_SIZE = 10;
const STREAM_INTERVAL_SEC = 60;
/** Shares the SAME account-wide bucket as campaign-sender's/iys-sync's own
 *  İYS preflights — one aggregate cap across every /iys/search caller. */
const IYS_SEARCH_BUDGET_LIMIT = 10;
const IYS_SEARCH_BUDGET_WINDOW_MS = 60_000;

interface AutocallCreds {
  usercode: string;
  password: string;
  brandCode: string;
}

/**
 * NetGSM Phase 5 Task 5 — the PARALLEL power-dialer, the "parallel mode"
 * counterpart to DialerService's preview (one-at-a-time click-to-dial)
 * queue. `start()` builds an audience the same way DialerService does (an
 * ordered, ≤100-lead, phone-present queue; REP callers clamped to their own
 * assigned leads), excludes any lead with `smsOptOut` (the DNC/opt-out
 * proxy `campaign-sender.service.ts`'s `isOptedOut('VOICE', …)` already
 * reuses — call opt-out has no dedicated column yet, see that file's
 * docstring), and — for a TİCARİ session — hard-blocks any lead İYS doesn't
 * confirm ONAY for ARAMA consent (mirrors `sendVoice`'s `iysArmaPreflight`,
 * but resolved ONCE at session-build time rather than per streaming tick:
 * streaming ≤100 numbers at 10/min takes at most ~10 minutes, and re-checking
 * consent that often would just re-spend the same shared `'iys'` budget for
 * no practical benefit — see the Task 5 report for this scope call).
 *
 * Only ONE session may be ACTIVE per workspace at a time (the underlying
 * NetGSM list + Netsantral queue are a shared team resource, not a per-rep
 * one — unlike DialSession, which is owned by the creating rep).
 *
 * Streaming numbers into the live NetGSM list happens in the background via
 * a self-rescheduling ScheduledJob (`autocall.stream`, mirrors
 * `campaign-sender.service.ts`'s `campaign.batch` ticking): `start()` only
 * creates the list + the FIRST tick's schedule, so the HTTP request never
 * blocks on the account's 10/min cap. `stop()` flips the session STOPPED and
 * best-effort calls `updateListStatus(..., 'stop')` — the app-side state is
 * authoritative even if that NetGSM call itself fails transiently (ops can
 * always finish tearing the list down manually in the NetGSM panel).
 */
@Injectable()
export class AutocallDialerService implements OnModuleInit {
  private readonly logger = new Logger(AutocallDialerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly autocall: AutocallClient,
    private readonly iysClient: IysClient,
    private readonly budgeter: AccountRateBudgeter,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(AUTOCALL_STREAM_KIND, (job) => this.streamTick(job));
  }

  /** Create the list, categorize the audience (PENDING/SKIPPED_DNC/
   *  SKIPPED_IYS), persist the session + items, start the list, and schedule
   *  the first streaming tick. Throws when nothing is actually callable
   *  (before ever creating a NetGSM resource for zero numbers). */
  async start(workspaceId: string, marketingUserId: string, role: string, dto: StartAutocallSessionDto) {
    const existing = await this.prisma.autocallSession.findFirst({ where: { workspaceId, status: 'ACTIVE' } });
    if (existing) {
      throw new ConflictException('A parallel autocall session is already running for this workspace — stop it first');
    }

    const creds = await this.resolveCreds(workspaceId);
    if (!creds) {
      throw new ServiceUnavailableException(
        'NetGSM otomatik arama için aktif bir SMS kanalı / kimlik bilgisi bulunamadı.',
      );
    }

    const isTicari = (dto.iysMessageType ?? 'TICARI') === 'TICARI';
    const iysfilter: '0' | '11' = isTicari ? '11' : '0';
    if (isTicari && !creds.brandCode) {
      throw new ServiceUnavailableException('TİCARİ otomatik arama için İYS marka kodu (brandCode) tanımlı değil.');
    }

    const effective: StartAutocallSessionDto =
      role === 'REP' ? { ...dto, assignedToId: marketingUserId } : dto;
    const rawLeads = await this.prisma.lead.findMany({
      where: { workspaceId, ...this.buildWhere(effective) },
      orderBy: { createdAt: 'asc' },
      take: MAX_QUEUE,
      select: { id: true, phone: true, smsOptOut: true },
    });
    if (rawLeads.length === 0) throw new BadRequestException('No callable leads match the filter');

    type Categorized = { leadId: string; phone: string; status: 'PENDING' | 'SKIPPED_DNC' | 'SKIPPED_IYS' };
    const categorized: Categorized[] = [];
    const iysCandidates: Array<{ leadId: string; phone: string }> = [];
    for (const l of rawLeads) {
      if (!l.phone) continue; // buildWhere already requires phone; defensive only
      if (l.smsOptOut) {
        categorized.push({ leadId: l.id, phone: l.phone, status: 'SKIPPED_DNC' });
        continue;
      }
      if (isTicari) {
        iysCandidates.push({ leadId: l.id, phone: l.phone });
        continue;
      }
      categorized.push({ leadId: l.id, phone: l.phone, status: 'PENDING' });
    }
    if (isTicari && iysCandidates.length > 0) {
      const onay = await this.iysOnaySet(creds, iysCandidates);
      for (const c of iysCandidates) {
        categorized.push({ leadId: c.leadId, phone: c.phone, status: onay.has(c.leadId) ? 'PENDING' : 'SKIPPED_IYS' });
      }
    }
    const eligible = categorized.filter((c) => c.status === 'PENDING');
    if (eligible.length === 0) {
      throw new BadRequestException(
        'İYS / arama izni (DNC) filtreleri sonrası aranabilecek kayıt kalmadı — otomatik arama listesi oluşturulmadı.',
      );
    }

    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    const reportUrl = netgsmWebhookUrl(base, workspaceId, 'autocall-report') ?? undefined;
    const listName = dto.listName?.trim() || `Parallel-${workspaceId.slice(0, 8)}-${Date.now()}`;

    const created = await this.autocall.addAutocall(
      { usercode: creds.usercode, password: creds.password },
      {
        listName,
        destinationType: 'queue',
        queueName: dto.queueName,
        iysfilter,
        ...(isTicari && creds.brandCode ? { brandcode: creds.brandCode } : {}),
        ...(dto.retryCount !== undefined ? { retryCount: dto.retryCount } : {}),
        ...(dto.timeWindows?.length ? { timeWindows: dto.timeWindows } : {}),
        ...(reportUrl ? { url: reportUrl } : {}),
      },
    );
    if (!created.ok || !created.listId) {
      throw new BadRequestException(created.message ?? 'NetGSM otomatik arama listesi oluşturulamadı.');
    }

    const session = await this.prisma.autocallSession.create({
      data: {
        workspaceId,
        startedByUserId: marketingUserId,
        status: 'ACTIVE',
        netgsmListId: created.listId,
        queueName: dto.queueName,
        iysfilter,
        brandCode: isTicari ? creds.brandCode : null,
        retryCount: dto.retryCount ?? null,
        total: categorized.length,
        items: {
          create: categorized.map((c) => ({ workspaceId, leadId: c.leadId, phone: c.phone, status: c.status })),
        },
      },
      select: { id: true },
    });

    const startResult = await this.autocall.updateListStatus(
      { usercode: creds.usercode, password: creds.password },
      created.listId,
      'start',
    );
    if (!startResult.ok) {
      // The list + numbers exist regardless — a failed 'start' call is
      // surfaced as a warning, not a thrown error, so the operator isn't left
      // with an orphaned NetGSM list this app no longer knows about. Ops can
      // retry start from the NetGSM panel directly if needed.
      this.logger.warn(
        `autocall session ${session.id}: NetGSM updateListStatus('start') failed — ${startResult.message}`,
      );
    }

    await this.scheduledJobs.schedule({
      workspaceId,
      kind: AUTOCALL_STREAM_KIND,
      runAt: new Date(),
      dedupKey: session.id,
      payload: { workspaceId, sessionId: session.id },
    });

    return this.getSession(workspaceId, session.id);
  }

  /** Flip the session STOPPED (idempotent — a second stop on an already-
   *  stopped session is a no-op read) and best-effort tear down the NetGSM
   *  list. App-side state is authoritative regardless of whether the NetGSM
   *  call itself succeeds. */
  async stop(workspaceId: string, id: string, _marketingUserId: string) {
    const session = await this.prisma.autocallSession.findFirst({ where: { id, workspaceId } });
    if (!session) throw new NotFoundException('Autocall session not found');

    const claim = await this.prisma.autocallSession.updateMany({
      where: { id, workspaceId, status: 'ACTIVE' },
      data: { status: 'STOPPED', stoppedAt: new Date() },
    });
    if (claim.count === 0) return this.getSession(workspaceId, id); // already stopped — idempotent

    const creds = await this.resolveCreds(workspaceId);
    if (!creds) {
      this.logger.warn(
        `autocall session ${id}: no resolvable NetGSM creds to send the stop — app-side state is stopped regardless`,
      );
      return this.getSession(workspaceId, id);
    }
    const res = await this.autocall.updateListStatus(
      { usercode: creds.usercode, password: creds.password },
      session.netgsmListId,
      'stop',
    );
    if (!res.ok) {
      this.logger.warn(
        `autocall session ${id}: NetGSM updateListStatus('stop') failed — ${res.message} (app-side state is stopped regardless)`,
      );
    }
    return this.getSession(workspaceId, id);
  }

  /** Session + per-item outcome counts, for the frontend's progress display. */
  async getSession(workspaceId: string, id: string) {
    const session = await this.prisma.autocallSession.findFirst({ where: { id, workspaceId } });
    if (!session) throw new NotFoundException('Autocall session not found');
    const [pending, added, skipped, failed] = await Promise.all([
      this.prisma.autocallSessionItem.count({ where: { autocallSessionId: id, workspaceId, status: 'PENDING' } }),
      this.prisma.autocallSessionItem.count({ where: { autocallSessionId: id, workspaceId, status: 'ADDED' } }),
      this.prisma.autocallSessionItem.count({
        where: { autocallSessionId: id, workspaceId, status: { in: ['SKIPPED_DNC', 'SKIPPED_IYS'] } },
      }),
      this.prisma.autocallSessionItem.count({ where: { autocallSessionId: id, workspaceId, status: 'FAILED' } }),
    ]);
    return {
      id: session.id,
      status: session.status,
      queueName: session.queueName,
      netgsmListId: session.netgsmListId,
      total: session.total,
      pending,
      added,
      skipped,
      failed,
    };
  }

  /** The workspace's current ACTIVE session (or null) — backs the frontend
   *  toggle's on-load state (is a parallel session already running?). */
  async getActive(workspaceId: string) {
    const session = await this.prisma.autocallSession.findFirst({
      where: { workspaceId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    return session ? this.getSession(workspaceId, session.id) : null;
  }

  /** Streams up to STREAM_BATCH_SIZE PENDING numbers into the live NetGSM
   *  list, then reschedules itself while PENDING items remain and the
   *  session is still ACTIVE. A budget-denied `addNumber` (retriable) stops
   *  the tick early — the account-wide cap is exhausted for every number,
   *  not just this one, so further calls this tick would only fail too. */
  private async streamTick(job: ClaimedJob): Promise<void> {
    const { workspaceId, sessionId } = job.payload as { workspaceId: string; sessionId: string };
    const session = await this.prisma.autocallSession.findFirst({ where: { id: sessionId, workspaceId } });
    if (!session || session.status !== 'ACTIVE') return; // stopped/gone — nothing left to stream

    const creds = await this.resolveCreds(workspaceId);
    if (!creds) {
      this.logger.warn(`autocall session ${sessionId}: no resolvable NetGSM creds this tick — retrying later`);
      await this.reschedule(session);
      return;
    }

    const pending = await this.prisma.autocallSessionItem.findMany({
      where: { autocallSessionId: sessionId, workspaceId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: STREAM_BATCH_SIZE,
    });

    for (const item of pending) {
      const result = await this.autocall.addNumber(
        { usercode: creds.usercode, password: creds.password },
        session.netgsmListId,
        item.phone,
      );
      if (result.ok) {
        await this.prisma.autocallSessionItem.update({ where: { id: item.id }, data: { status: 'ADDED' } });
        continue;
      }
      if (result.retriable) break; // account-wide budget exhausted — resume next tick
      await this.prisma.autocallSessionItem.update({ where: { id: item.id }, data: { status: 'FAILED' } });
    }

    const remaining = await this.prisma.autocallSessionItem.count({
      where: { autocallSessionId: sessionId, workspaceId, status: 'PENDING' },
    });
    if (remaining > 0) await this.reschedule(session);
  }

  private async reschedule(session: { id: string; workspaceId: string }): Promise<void> {
    await this.scheduledJobs.schedule({
      workspaceId: session.workspaceId,
      kind: AUTOCALL_STREAM_KIND,
      runAt: new Date(Date.now() + STREAM_INTERVAL_SEC * 1000),
      dedupKey: session.id,
      payload: { workspaceId: session.workspaceId, sessionId: session.id },
    });
  }

  /** İYS ARAMA search per candidate (cached per normalized phone within this
   *  one call), budgeted via the SAME shared `'iys'` bucket every other İYS
   *  caller uses. Unverifiable numbers and budget-denied lookups are simply
   *  excluded (fail closed) — this builds a CANDIDATE set, so there's no
   *  already-reserved spend to refund/abort the way campaign-sender's
   *  per-tick preflight has to. */
  private async iysOnaySet(
    creds: AutocallCreds,
    candidates: Array<{ leadId: string; phone: string }>,
  ): Promise<Set<string>> {
    const iysCreds = { usercode: creds.usercode, password: creds.password, brandCode: creds.brandCode };
    const cache = new Map<string, IysSearchResult>();
    const onay = new Set<string>();
    for (const c of candidates) {
      const wirePhone = toIysMsisdn(c.phone);
      if (!wirePhone) continue; // can't verify → excluded, never sent anyway
      let res = cache.get(wirePhone);
      if (!res) {
        if (!this.budgeter.tryTake(creds.usercode, 'iys', IYS_SEARCH_BUDGET_LIMIT, IYS_SEARCH_BUDGET_WINDOW_MS)) {
          continue; // budget exhausted this run — excluded; a re-run picks up the rest
        }
        res = await this.iysClient.search(iysCreds, wirePhone, 'ARAMA');
        cache.set(wirePhone, res);
      }
      if (res.ok && res.status === 'ONAY') onay.add(c.leadId);
    }
    return onay;
  }

  /** Same shape DialerService.buildWhere uses — an ordered, callable-only
   *  (phone present, not deleted/merged) audience filter. */
  private buildWhere(filter: StartAutocallSessionDto): Prisma.LeadWhereInput {
    return {
      deletedAt: null,
      mergedIntoId: null,
      phone: { not: null },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assignedToId ? { assignedToId: filter.assignedToId } : {}),
      ...(filter.businessType ? { businessType: filter.businessType } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.city ? { city: { contains: filter.city, mode: 'insensitive' } } : {}),
      ...(filter.search
        ? {
            OR: [
              { businessName: { contains: filter.search, mode: 'insensitive' } },
              { contactPerson: { contains: filter.search, mode: 'insensitive' } },
              { phone: { contains: filter.search } },
            ],
          }
        : {}),
    };
  }

  /** `/autocallservice` reuses the SAME account (usercode/password) as
   *  voicesms/send — mirrors `campaign-sender.service.ts`'s `sendVoice`
   *  credential resolution exactly (no separate "autocall channel" row). */
  private async resolveCreds(workspaceId: string): Promise<AutocallCreds | null> {
    const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
    if (!ch) return null;
    const resolved = this.registry.resolveConfig(ch);
    const { usercode, password } = resolved.secrets;
    if (!usercode || !password) return null;
    return {
      usercode,
      password,
      brandCode: typeof resolved.public?.brandCode === 'string' ? (resolved.public.brandCode as string).trim() : '',
    };
  }
}
