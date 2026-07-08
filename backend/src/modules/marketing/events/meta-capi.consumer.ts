import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes } from './marketing-event-types';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isMetaAdsConfigured } from '../ads/ads.types';
import { isMetaAuthError } from '../../../common/util/meta-graph.util';
import {
  sendConversionEvent,
  sha256,
  toE164Digits,
  buildFbc,
  CapiEvent,
  CapiUserData,
} from '../ads/meta-capi.client';

interface OpportunityWonPayload {
  workspaceId: string;
  opportunityId: string;
  leadId: string | null;
  value: number; // major units
  occurredAt: string;
}

interface InvoicePaidPayload {
  workspaceId: string;
  invoiceId: string;
  leadId: string | null;
  total: number; // MINOR units (kuruş/cents)
  currency: string;
  via: string;
  occurredAt: string;
}

/**
 * Meta Conversions API (CAPI) feedback loop. When a deal is WON or an invoice is
 * PAID, POST a server-side `Purchase` event back to the workspace's Meta pixel
 * with the click-id captured at lead birth + hashed PII, so the ad algorithm can
 * optimize on real downstream outcomes the browser pixel never sees.
 *
 * Closes the loop that was 100% open outbound: every input (click-ids on
 * LeadAttribution, conversion events on the outbox) was already collected; this
 * consumer is the missing last metre.
 *
 * Ships dark: inert unless the platform has Meta app creds AND the workspace has
 * a connected META AdAccount with a `pixelId`. Delivery is at-least-once, so the
 * event is deduped by `event.id` (Meta dedupes server+pixel on event_id).
 */
@Injectable()
export class MetaCapiConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetaCapiConsumer.name);

  // Stable handler refs so onModuleDestroy can detach them (no leaked listeners
  // across HMR / test teardown / app close).
  private readonly onOpportunityWon = (e: DomainEvent<unknown>) =>
    this.handleWon(e as DomainEvent<OpportunityWonPayload>);
  private readonly onInvoicePaid = (e: DomainEvent<unknown>) =>
    this.handlePaid(e as DomainEvent<InvoicePaidPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.OpportunityWon, this.onOpportunityWon);
    this.bus.on(MarketingEventTypes.InvoicePaid, this.onInvoicePaid);
  }

  onModuleDestroy(): void {
    this.bus.off(MarketingEventTypes.OpportunityWon, this.onOpportunityWon);
    this.bus.off(MarketingEventTypes.InvoicePaid, this.onInvoicePaid);
  }

  private async handleWon(event: DomainEvent<OpportunityWonPayload>): Promise<void> {
    const p = event.payload;
    // Opportunity value is already in major units; currency isn't on the payload,
    // so fall back to the ad account's currency below.
    await this.send(event.id, p.workspaceId, p.leadId, {
      value: p.value,
      currency: null,
      occurredAt: p.occurredAt,
    });
  }

  private async handlePaid(event: DomainEvent<InvoicePaidPayload>): Promise<void> {
    const p = event.payload;
    // Invoice total is MINOR units (kuruş/cents) → convert to major for CAPI.
    await this.send(event.id, p.workspaceId, p.leadId, {
      value: p.total / 100,
      currency: p.currency,
      occurredAt: p.occurredAt,
    });
  }

  private async send(
    eventId: string,
    workspaceId: string,
    leadId: string | null,
    conv: { value: number; currency: string | null; occurredAt: string },
  ): Promise<void> {
    if (!isMetaAdsConfigured()) return; // platform not configured → inert

    try {
      const account = await this.prisma.adAccount.findFirst({
        where: { workspaceId, provider: 'META' },
        select: { id: true, pixelId: true, capiToken: true, accessToken: true, currency: true },
      });
      if (!account?.pixelId) {
        // No Meta pixel wired for this workspace — nothing to feed. Silent by
        // design (the inert-feature rule); most workspaces won't have CAPI set.
        return;
      }

      let token: string;
      try {
        token = openSecret(account.capiToken ?? account.accessToken);
      } catch {
        this.logger.warn(`CAPI token decrypt failed for workspace ${workspaceId} — skipping event ${eventId}`);
        return;
      }

      const userData = await this.buildUserData(leadId);
      // No match key at all (no lead, no PII, no click id) → Meta can't attribute
      // the event, so don't spend the call.
      if (Object.keys(userData).length === 0) {
        this.logger.debug(`CAPI event ${eventId}: no match keys — skipping`);
        return;
      }

      const event: CapiEvent = {
        event_name: 'Purchase',
        event_time: Math.floor(new Date(conv.occurredAt).getTime() / 1000),
        event_id: eventId,
        action_source: 'system_generated',
        user_data: userData,
        custom_data: {
          value: conv.value,
          currency: (conv.currency ?? account.currency ?? 'TRY').toUpperCase(),
        },
      };

      const r = await sendConversionEvent(token, account.pixelId, event);
      if (!r.ok) {
        this.logger.warn(`CAPI send failed for event ${eventId}: ${r.error?.message ?? r.status}`);
        if (isMetaAuthError(r)) {
          await this.prisma.adAccount
            .update({ where: { id: account.id }, data: { status: 'TOKEN_EXPIRED', lastError: 'reauth_required' } })
            .catch(() => undefined);
        }
      }
    } catch (err: any) {
      // At-least-once bus swallows per-listener throws; a CAPI blip must never
      // break the conversion flow, so log and move on (dedup on event_id makes a
      // future redelivery safe).
      this.logger.error(`CAPI consumer failed for event ${eventId}: ${err?.message ?? err}`);
    }
  }

  /** Assemble Meta Advanced-Matching user_data from the lead's PII + click id. */
  private async buildUserData(leadId: string | null): Promise<CapiUserData> {
    const out: CapiUserData = {};
    if (!leadId) return out;

    const [lead, attribution] = await Promise.all([
      this.prisma.lead.findUnique({
        where: { id: leadId },
        select: { emailNormalized: true, phoneNormalized: true, city: true },
      }),
      this.prisma.leadAttribution.findUnique({
        where: { leadId },
        select: { clickId: true, clickIdType: true, ctwaClid: true, createdAt: true },
      }),
    ]);

    if (lead) {
      const em = sha256(lead.emailNormalized);
      if (em) out.em = em;
      const ph = sha256(toE164Digits(lead.phoneNormalized));
      if (ph) out.ph = ph;
      const ct = sha256(lead.city);
      if (ct) out.ct = ct;
    }
    if (attribution) {
      if (attribution.clickIdType === 'FBCLID' && attribution.clickId) {
        const fbc = buildFbc(attribution.clickId, attribution.createdAt);
        if (fbc) out.fbc = fbc;
      }
      if (attribution.ctwaClid) out.ctwa_clid = attribution.ctwaClid;
    }
    return out;
  }
}
