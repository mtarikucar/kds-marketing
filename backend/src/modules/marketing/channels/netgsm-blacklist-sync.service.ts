import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes, MarketingSmsOptStatusPayload } from '../events/marketing-event-types';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { BlacklistClient } from '../../netgsm/sms/blacklist.client';

type NetgsmCreds = { usercode: string; password: string };
type Action = 'add' | 'remove';

/**
 * Mirrors a lead's SMS opt-out/opt-in transition onto NetGSM's account-level
 * blacklist — defense-in-depth ONLY. İYS + the app's own smsOptOut checks
 * (campaign-sender.service.ts, workflow-action.handler.ts) remain the PRIMARY
 * enforcement; this just ensures a bypass of the app-side gate still can't
 * reach an opted-out number.
 *
 * Producers (ComplianceService's MARKETING_SMS consent writes,
 * CampaignTrackingService's public unsubscribe route) append
 * `marketing.sms.optout.v1` / `marketing.sms.optin.v1` to the outbox; this
 * service subscribes via `DomainEventBus.on` (settlement-commission.consumer
 * idiom: stable handler refs registered in onModuleInit, detached in
 * onModuleDestroy so HMR/test teardown doesn't leak listeners).
 *
 * Retry semantics — READ THIS BEFORE "fixing" the throw-for-retry pattern:
 * `DomainEventBus.dispatch()` SWALLOWS every per-listener error (by design —
 * see its class docstring) and `OutboxWorkerService.drainOnce()` only ever
 * sees `dispatch()` resolve, never reject, so it always marks the row
 * 'dispatched' regardless of what a listener did. Throwing from this
 * service's handler would NOT cause the outbox worker to retry the event —
 * it would just be logged by the bus and dropped. So a NetGSM per-account
 * rate-budget denial (`AccountRateBudgeter.tryTake`, 120 numbers/min) is
 * handled with our OWN bounded in-process retry instead: a real `setTimeout`
 * reschedule at 1s / 5s / 15s (max 3 extra attempts), non-blocking so it never
 * stalls the bus's dispatch loop for other events. After the 3rd denial we
 * log a warn (with the lead id) and drop — acceptable because this is
 * defense-in-depth, not the primary compliance control.
 *
 * Dedup: `DomainEvent.id` (UUIDv7 from the outbox row) is the bus's own
 * "consumers MUST dedupe on this" contract — a bounded in-memory Set of
 * recently-seen ids (same accepted single-instance limitation as
 * AccountRateBudgeter / the entitlements cache) guards against a redelivery
 * from the worker's orphan-reclaim sweep re-dispatching the same row.
 */
@Injectable()
export class NetgsmBlacklistSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NetgsmBlacklistSyncService.name);

  private static readonly BUDGET_LIMIT = 120;
  private static readonly BUDGET_WINDOW_MS = 60_000;
  /** 1s, 5s, 15s — 3 extra attempts after the first denial, then drop. */
  private static readonly RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
  /** Bounded dedup cache; oldest entries evicted once the cap is hit. */
  private static readonly MAX_SEEN_IDS = 2_000;

  private readonly seenEventIds = new Set<string>();

  private readonly optOutHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingSmsOptStatusPayload>, 'add');
  private readonly optInHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<MarketingSmsOptStatusPayload>, 'remove');

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly registry: ChannelAdapterRegistry,
    private readonly budgeter: AccountRateBudgeter,
    private readonly client: BlacklistClient,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.SmsOptedOut, this.optOutHandler);
    this.bus.on(MarketingEventTypes.SmsOptedIn, this.optInHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.SmsOptedOut, this.optOutHandler);
    this.bus.off(MarketingEventTypes.SmsOptedIn, this.optInHandler);
  }

  private async handle(
    event: DomainEvent<MarketingSmsOptStatusPayload>,
    action: Action,
  ): Promise<void> {
    if (this.seenEventIds.has(event.id)) return; // already processed (replay)
    this.remember(event.id);

    const { workspaceId, leadId, phone } = event.payload ?? ({} as MarketingSmsOptStatusPayload);
    if (!workspaceId || !leadId || !phone) {
      this.logger.warn(`netgsm blacklist ${action}: event ${event.id} missing workspaceId/leadId/phone — skipping`);
      return;
    }

    const creds = await this.getCreds(workspaceId);
    if (!creds) {
      this.logger.warn(
        `netgsm blacklist ${action}: no ACTIVE SMS channel credentials for workspace=${workspaceId} — skipping lead=${leadId}`,
      );
      return;
    }

    await this.attempt(creds, phone, action, leadId, 0);
  }

  /** One budget-gated attempt. On denial, schedules a bounded non-blocking
   *  retry rather than throwing (see class docstring for why throwing is a
   *  no-op against the outbox worker). */
  private async attempt(
    creds: NetgsmCreds,
    phone: string,
    action: Action,
    leadId: string,
    retryCount: number,
  ): Promise<void> {
    if (!this.budgeter.tryTake(creds.usercode, 'blacklist', NetgsmBlacklistSyncService.BUDGET_LIMIT, NetgsmBlacklistSyncService.BUDGET_WINDOW_MS)) {
      this.scheduleRetry(creds, phone, action, leadId, retryCount);
      return;
    }
    const result = action === 'add' ? await this.client.add(creds, phone) : await this.client.remove(creds, phone);
    if (!result.ok) {
      this.logger.warn(`netgsm blacklist ${action} failed for lead=${leadId}: ${result.message ?? result.code}`);
    }
  }

  private scheduleRetry(creds: NetgsmCreds, phone: string, action: Action, leadId: string, retryCount: number): void {
    if (retryCount >= NetgsmBlacklistSyncService.RETRY_DELAYS_MS.length) {
      this.logger.warn(
        `netgsm blacklist ${action} dropped for lead=${leadId}: rate budget denied ${retryCount} retries in a row. ` +
          'Blacklist is defense-in-depth only — İYS + app-side opt-out checks remain the primary enforcement.',
      );
      return;
    }
    const delayMs = NetgsmBlacklistSyncService.RETRY_DELAYS_MS[retryCount];
    setTimeout(() => {
      void this.attempt(creds, phone, action, leadId, retryCount + 1);
    }, delayMs);
  }

  /** Resolve the workspace's NetGSM SMS credentials — mirrors
   *  CallCdrSyncService.getCreds's ACTIVE-SMS-channel lookup. */
  private async getCreds(workspaceId: string): Promise<NetgsmCreds | null> {
    const channels = await this.prisma.channel.findMany({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
    });
    for (const ch of channels) {
      const secrets = this.registry.resolveConfig(ch as any).secrets;
      if (secrets?.usercode && secrets?.password) {
        return { usercode: secrets.usercode, password: secrets.password };
      }
    }
    return null;
  }

  private remember(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > NetgsmBlacklistSyncService.MAX_SEEN_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }
}
