import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes, MarketingVoiceReportPayload } from '../events/marketing-event-types';

/** Canonical voiceState vocabulary this consumer writes — see `mapVoiceState`. */
type VoiceState = 'ANSWERED' | 'BUSY' | 'NO_ANSWER' | 'FAILED' | 'UNKNOWN';
const VOICE_STATES: readonly VoiceState[] = ['ANSWERED', 'BUSY', 'NO_ANSWER', 'FAILED', 'UNKNOWN'];

/**
 * Voice-report webhook consumer (NetGSM Phase 5 Task 3). Subscribes
 * `marketing.voice.report.v1` (published by NetgsmEventsController's
 * `voice-report` route from a NEW (relationid, state) element it archived)
 * and:
 *
 *  - correlates PURELY by `relationid` == `CampaignRecipient.id`,
 *    workspace-scoped (`findFirst({ id: relationid, workspaceId })`). An
 *    unknown/unresolvable relationid is skipped + logged — never guessed at
 *    via a phone-number fallback the way the SMS DLR poll does, since voice's
 *    `relationid` is always OUR OWN id, not a provider-assigned reference
 *    that could plausibly go missing. Deliberately NEVER touches
 *    `netgsmJobId`/`referansId` — those two columns are the SMS DLR-poll
 *    reconciler's own unscoped signal (`netgsm-dlr-poll.service.ts`'s
 *    `pollV2Campaigns` selects ANY recipient row with `netgsmJobId` set, not
 *    scoped to `campaign.channel === 'SMS'`) — see Task 2's migration
 *    docstring for the full reasoning this consumer inherits.
 *
 *  - writes `voiceState`/`pushButton`/`talkSec`, GUARDED so a terminal
 *    `ANSWERED` outcome is never regressed. `ANSWERED` is the one truly
 *    terminal/success state — a real conversation happened, and no later
 *    report (an out-of-order intermediate push, a redelivery, or a genuinely
 *    later distinct-state push for the same call) can un-happen it. Every
 *    other state (BUSY/NO_ANSWER/FAILED/UNKNOWN) can still be overwritten by
 *    a later distinct-state push — that's the legitimate case of an
 *    intermediate signal followed by the call's real final outcome.
 *    `pushButton`/`talkSec` are written independently of that guard (a
 *    press-1 or a duration can land in a LATER push after the call was
 *    already marked ANSWERED by an earlier one).
 *
 *  - rolls voice-outcome counters into `campaign.stats` (spread-preserve
 *    merge — never clobbers `sent`/`delivered`/`opened`/`clicked`/…, same
 *    discipline as `campaign-sender.service.ts`'s `recomputeStats` and
 *    `netgsm-dlr-poll.service.ts`'s `rollupCampaignStats`). Recomputed from
 *    the recipient rows (groupBy), not incrementally bumped, so it's immune
 *    to a lost-update race under concurrent webhook deliveries for the same
 *    campaign.
 *
 *  - PRESS-1 → workflow trigger: when `pushButton` matches one of the
 *    campaign's configured `voiceConfig.keys`, emits
 *    `marketing.voice.keypress.v1` (idempotencyKey scoped by
 *    `recipientId:key`, so a redelivered/duplicate press never double-fires
 *    the workflow) — `WorkflowTriggerService`'s `voice_keypress` trigger
 *    picks it up.
 *
 * IDEMPOTENCY: `DomainEvent.id` dedupe (bounded in-memory Set — same idiom as
 * TelephonyEventConsumer/IysWebhookConsumer) guards the outbox worker's
 * orphan-reclaim sweep re-dispatching the same row. The controller's own
 * per-(relationid,state) archive dedupe means a genuinely NEW event reaching
 * this consumer is either the call's first report or a real distinct-state
 * transition — never a bare redelivery of an already-seen state.
 *
 * `recordLink` (the call recording URL): `CampaignRecipient` has no
 * dedicated column for it — Task 2 added `voiceState`/`pushButton`/`talkSec`
 * only. Logged for now rather than silently dropped; a future
 * migration/column can persist it.
 */
@Injectable()
export class VoiceReportConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoiceReportConsumer.name);

  /** Bounded dedup cache; oldest entries evicted once the cap is hit —
   *  mirrors TelephonyEventConsumer/IysWebhookConsumer's seenEventIds idiom. */
  private static readonly MAX_SEEN_IDS = 2_000;
  private readonly seenEventIds = new Set<string>();

  // v3.0.1 round-4 audit fix idiom (see SettlementCommissionConsumer /
  // TelephonyEventConsumer) — a stable handler ref so onModuleDestroy can
  // detach it; an inline closure registered once but never removed leaks
  // across HMR/test teardown.
  private readonly reportHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingVoiceReportPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.VoiceReport, this.reportHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.VoiceReport, this.reportHandler);
  }

  private async handle(event: DomainEvent<MarketingVoiceReportPayload>): Promise<void> {
    if (this.seenEventIds.has(event.id)) return; // already processed (replay)
    this.remember(event.id);

    const p = event.payload ?? ({} as MarketingVoiceReportPayload);
    if (!p.workspaceId || !p.relationid) {
      this.logger.warn(`voice report event ${event.id} missing workspaceId/relationid — skipping`);
      return;
    }

    const recipient = await this.prisma.campaignRecipient.findFirst({
      where: { id: p.relationid, workspaceId: p.workspaceId },
      select: { id: true, workspaceId: true, campaignId: true, leadId: true, voiceState: true },
    });
    if (!recipient) {
      this.logger.warn(
        `voice report event ${event.id}: no CampaignRecipient for relationid=${p.relationid} workspace=${p.workspaceId} — unknown relationid, skipping`,
      );
      return;
    }

    const mappedState = this.mapVoiceState(p.state, p.bilsec);
    const patch: { voiceState?: VoiceState; pushButton?: string; talkSec?: number } = {};
    // Guarded monotonic write — see class docstring. ANSWERED, once recorded,
    // is never regressed by a later report; every other state can still be
    // updated (including upgraded TO answered).
    if (recipient.voiceState !== 'ANSWERED' && mappedState !== recipient.voiceState) {
      patch.voiceState = mappedState;
    }
    if (p.pushButton) patch.pushButton = p.pushButton;
    if (p.bilsec != null) patch.talkSec = p.bilsec;

    if (Object.keys(patch).length > 0) {
      await this.prisma.campaignRecipient.update({ where: { id: recipient.id }, data: patch });
    }

    if (patch.voiceState) {
      await this.rollupVoiceStats(recipient.workspaceId, recipient.campaignId);
    }

    if (p.recordLink) {
      // No dedicated recording-link column on CampaignRecipient yet (see
      // class docstring) — logged, not silently dropped.
      this.logger.log(
        `voice report: recipient ${recipient.id} has a recordLink but no column to persist it yet (logged only): ${p.recordLink}`,
      );
    }

    if (p.pushButton) {
      await this.maybeTriggerKeypress(
        { id: recipient.id, workspaceId: recipient.workspaceId, campaignId: recipient.campaignId, leadId: recipient.leadId },
        p.pushButton,
      );
    }
  }

  /**
   * NetGSM's voicesms report durum/state codes (1/2/3/7 per the phase plan's
   * researched facts) mapped to a small canonical vocabulary. The exact
   * NetGSM-published semantics for each numeric code are NOT live-verified
   * (this program's familiar "researched, not yet live-verified" caveat —
   * see `VoicesmsSendClient`'s own docstring); the mapping below
   * (1=answered, 2=busy, 3=no answer, 7=failed) is the best-available
   * inference. To hedge that risk, `bilsec` (actual talk seconds) is treated
   * as the AUTHORITATIVE signal when present and positive — a real, non-zero
   * talk duration proves the call was answered regardless of what the durum
   * code says, the same defensive idiom `TelephonyEventConsumer.
   * terminalStatusFor` already uses for santral events (`durationSec > 0`
   * wins over a string status token). An unrecognized/missing code is
   * 'UNKNOWN' — never guessed as ANSWERED (this only gates a stats/UI label,
   * not a compliance decision, so recording SOMETHING is better than
   * dropping the report, but it must never be a false positive).
   */
  private mapVoiceState(state: string | null | undefined, bilsec: number | null | undefined): VoiceState {
    if (bilsec != null && bilsec > 0) return 'ANSWERED';
    switch (String(state ?? '').trim()) {
      case '1':
        return 'ANSWERED';
      case '2':
        return 'BUSY';
      case '3':
        return 'NO_ANSWER';
      case '7':
        return 'FAILED';
      default:
        return 'UNKNOWN';
    }
  }

  /** When `pushButton` matches one of the campaign's configured
   *  `voiceConfig.keys`, emits `marketing.voice.keypress.v1` — idempotent per
   *  (recipientId, key) so a redelivered/duplicate press never double-fires
   *  a workflow. A pushButton NOT in the configured keys is a no-op (still
   *  persisted onto the recipient row above, just not a trigger source). */
  private async maybeTriggerKeypress(
    recipient: { id: string; workspaceId: string; campaignId: string; leadId: string },
    pushButton: string,
  ): Promise<void> {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: recipient.campaignId, workspaceId: recipient.workspaceId },
      select: { voiceConfig: true },
    });
    const keys = this.voiceConfigKeys(campaign?.voiceConfig);
    if (!keys.includes(pushButton)) return;

    await this.outbox.append({
      type: MarketingEventTypes.VoiceKeypress,
      tenantId: null,
      payload: {
        workspaceId: recipient.workspaceId,
        leadId: recipient.leadId,
        campaignId: recipient.campaignId,
        recipientId: recipient.id,
        key: pushButton,
      },
      idempotencyKey: `voice-keypress:${recipient.id}:${pushButton}`,
    });
  }

  private voiceConfigKeys(voiceConfig: unknown): string[] {
    if (!voiceConfig || typeof voiceConfig !== 'object') return [];
    const keys = (voiceConfig as { keys?: unknown }).keys;
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
  }

  /** Rolls voice-outcome counters into `campaign.stats` — a MERGE (spreads
   *  the existing blob first) so this never clobbers keys owned by other
   *  writers (sent/failed/skipped/opened/clicked/…). Recomputed from the
   *  recipient rows (groupBy) rather than incrementally bumped — immune to
   *  the lost-update race a plain read-modify-write JSON blob would have
   *  under concurrent webhook deliveries for the same campaign (mirrors
   *  CampaignSenderService.recomputeStats's own reasoning). */
  private async rollupVoiceStats(workspaceId: string, campaignId: string): Promise<void> {
    const [groups, pressed] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ['voiceState'],
        where: { workspaceId, campaignId, voiceState: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, pushButton: { not: null } } }),
    ]);
    const countOf = (state: VoiceState) =>
      (groups as Array<{ voiceState: string | null; _count: { _all: number } }>).find((g) => g.voiceState === state)
        ?._count._all ?? 0;

    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId }, select: { stats: true } });
    if (!campaign) return;
    const stats = campaign.stats && typeof campaign.stats === 'object' ? (campaign.stats as Record<string, unknown>) : {};
    const voiceCounts: Record<string, number> = {};
    for (const s of VOICE_STATES) voiceCounts[`voice${this.pascal(s)}`] = countOf(s);

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        stats: {
          ...stats,
          ...voiceCounts,
          voicePressed: pressed,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** 'NO_ANSWER' -> 'NoAnswer', 'ANSWERED' -> 'Answered' — used to build the
   *  `voice<State>` stats key names (voiceAnswered/voiceBusy/voiceNoAnswer/
   *  voiceFailed/voiceUnknown). */
  private pascal(s: string): string {
    return s
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  private remember(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > VoiceReportConsumer.MAX_SEEN_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}
