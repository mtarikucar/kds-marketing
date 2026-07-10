import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes } from './marketing-event-types';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isMetaAdsConfigured, isTiktokAdsConfigured, isGoogleAdsConfigured } from '../ads/ads.types';
import { isMetaAuthError } from '../../../common/util/meta-graph.util';
import {
  sendConversionEvent,
  sha256,
  toE164Digits,
  buildFbc,
  CapiEvent,
  CapiUserData,
} from '../ads/meta-capi.client';
import { sendTiktokEvent, buildTiktokUserData } from '../ads/tiktok-capi.client';
import { uploadClickConversion, formatGoogleConversionDateTime } from '../ads/google-ads-conversions.client';
import { isGoogleAuthError } from '../ads/google-ads.util';

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

interface Conversion {
  value: number; // major units
  currency: string | null;
  occurredAt: string;
}

interface LeadContext {
  emailNormalized: string | null;
  phoneNormalized: string | null;
  city: string | null;
  clickId: string | null;
  clickIdType: string | null;
  ctwaClid: string | null;
  attributionCreatedAt: Date | null;
}

/**
 * Server-side conversion feedback loop across ad platforms. When a deal is WON
 * or an invoice is PAID, POST the matched conversion back to every configured
 * platform — Meta Conversions API, TikTok Events API, Google Ads offline
 * conversions — with the click-id captured at lead birth + hashed PII, so each
 * ad algorithm can optimize on real downstream outcomes the browser pixel never
 * sees.
 *
 * Closes the loop that was 100% open outbound. Each provider is independent and
 * best-effort (Promise.allSettled): one platform's blip never blocks the others
 * or the conversion flow. Ships dark per provider — inert unless that platform's
 * creds AND a connected account with its conversion destination exist. Delivery
 * is at-least-once, so every event is deduped on the outbox event.id.
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
    await this.send(event.id, p.workspaceId, p.leadId, { value: p.value, currency: null, occurredAt: p.occurredAt });
  }

  private async handlePaid(event: DomainEvent<InvoicePaidPayload>): Promise<void> {
    const p = event.payload;
    // Invoice total is MINOR units (kuruş/cents) → convert to major for feedback.
    await this.send(event.id, p.workspaceId, p.leadId, { value: p.total / 100, currency: p.currency, occurredAt: p.occurredAt });
  }

  private async send(eventId: string, workspaceId: string, leadId: string | null, conv: Conversion): Promise<void> {
    // Skip entirely when no platform is configured at all.
    if (!isMetaAdsConfigured() && !isTiktokAdsConfigured() && !isGoogleAdsConfigured()) return;
    const ctx = await this.loadLeadContext(leadId);
    // Fire each configured platform independently; a failure in one never blocks
    // the others (the bus swallows per-listener throws, but we also isolate here).
    await Promise.allSettled([
      this.sendMeta(eventId, workspaceId, conv, ctx),
      this.sendTiktok(eventId, workspaceId, conv, ctx),
      this.sendGoogle(eventId, workspaceId, conv, ctx),
    ]);
  }

  // ── Meta ────────────────────────────────────────────────────────────────
  private async sendMeta(eventId: string, workspaceId: string, conv: Conversion, ctx: LeadContext): Promise<void> {
    if (!isMetaAdsConfigured()) return;
    try {
      const account = await this.prisma.adAccount.findFirst({
        where: { workspaceId, provider: 'META' },
        select: { id: true, pixelId: true, capiToken: true, accessToken: true, currency: true },
      });
      if (!account?.pixelId) return; // no Meta pixel wired → inert
      let token: string;
      try {
        token = openSecret(account.capiToken ?? account.accessToken);
      } catch {
        this.logger.warn(`Meta CAPI token decrypt failed for workspace ${workspaceId} — skipping ${eventId}`);
        return;
      }
      const userData = this.metaUserData(ctx);
      if (Object.keys(userData).length === 0) return; // no match key → skip
      const event: CapiEvent = {
        event_name: 'Purchase',
        event_time: Math.floor(new Date(conv.occurredAt).getTime() / 1000),
        event_id: eventId,
        action_source: 'system_generated',
        user_data: userData,
        custom_data: { value: conv.value, currency: (conv.currency ?? account.currency ?? 'TRY').toUpperCase() },
      };
      const r = await sendConversionEvent(token, account.pixelId, event);
      if (!r.ok) {
        this.logger.warn(`Meta CAPI send failed for ${eventId}: ${r.error?.message ?? r.status}`);
        if (isMetaAuthError(r)) await this.markReauth(account.id);
      }
    } catch (err: any) {
      this.logger.error(`Meta CAPI failed for ${eventId}: ${err?.message ?? err}`);
    }
  }

  // ── TikTok Events API ─────────────────────────────────────────────────────
  private async sendTiktok(eventId: string, workspaceId: string, conv: Conversion, ctx: LeadContext): Promise<void> {
    if (!isTiktokAdsConfigured()) return;
    try {
      const account = await this.prisma.adAccount.findFirst({
        where: { workspaceId, provider: 'TIKTOK' },
        select: { id: true, tiktokPixelCode: true, accessToken: true, currency: true },
      });
      if (!account?.tiktokPixelCode) return; // no TikTok pixel wired → inert
      let token: string;
      try {
        token = openSecret(account.accessToken);
      } catch {
        this.logger.warn(`TikTok token decrypt failed for workspace ${workspaceId} — skipping ${eventId}`);
        return;
      }
      const user = buildTiktokUserData({
        email: ctx.emailNormalized,
        phone: ctx.phoneNormalized,
        ttclid: ctx.clickIdType === 'TTCLID' ? ctx.clickId : null,
      });
      if (Object.keys(user).length === 0) return; // no match key → skip
      const r = await sendTiktokEvent(token, account.tiktokPixelCode, {
        event: 'CompletePayment',
        event_time: Math.floor(new Date(conv.occurredAt).getTime() / 1000),
        event_id: eventId,
        user,
        properties: { value: conv.value, currency: (conv.currency ?? account.currency ?? 'TRY').toUpperCase() },
      });
      if (!r.ok) {
        // TiktokBusinessResult is a discriminated union; strictNullChecks:false
        // doesn't narrow it, so read the error branch defensively.
        const err = (r as { ok: false; error?: { message?: string; isAuthError?: boolean } }).error;
        this.logger.warn(`TikTok Events send failed for ${eventId}: ${err?.message ?? ''}`);
        if (err?.isAuthError) await this.markReauth(account.id);
      }
    } catch (err: any) {
      this.logger.error(`TikTok Events failed for ${eventId}: ${err?.message ?? err}`);
    }
  }

  // ── Google Ads offline conversion ─────────────────────────────────────────
  private async sendGoogle(eventId: string, workspaceId: string, conv: Conversion, ctx: LeadContext): Promise<void> {
    if (!isGoogleAdsConfigured()) return;
    // Google offline conversions key on the gclid — no gclid, no upload.
    if (ctx.clickIdType !== 'GCLID' || !ctx.clickId) return;
    try {
      const account = await this.prisma.adAccount.findFirst({
        where: { workspaceId, provider: 'GOOGLE' },
        select: { id: true, googleConversionActionId: true, accessToken: true, externalAdId: true, currency: true },
      });
      if (!account?.googleConversionActionId) return; // no conversion action wired → inert
      let refreshToken: string;
      try {
        refreshToken = openSecret(account.accessToken);
      } catch {
        this.logger.warn(`Google refresh-token decrypt failed for workspace ${workspaceId} — skipping ${eventId}`);
        return;
      }
      const r = await uploadClickConversion(
        refreshToken,
        account.externalAdId,
        {
          gclid: ctx.clickId,
          conversionAction: account.googleConversionActionId,
          conversionValue: conv.value,
          currencyCode: (conv.currency ?? account.currency ?? 'TRY').toUpperCase(),
          conversionDateTime: formatGoogleConversionDateTime(new Date(conv.occurredAt)),
          orderId: eventId,
        },
        { loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? null },
      );
      if (!r.ok) {
        this.logger.warn(`Google offline conversion failed for ${eventId}: ${r.error ?? ''}`);
        if (r.isAuthError || isGoogleAuthError(r)) await this.markReauth(account.id);
      }
    } catch (err: any) {
      this.logger.error(`Google offline conversion failed for ${eventId}: ${err?.message ?? err}`);
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────────────
  /** Load the lead's PII + click id once, shared across every provider send. */
  private async loadLeadContext(leadId: string | null): Promise<LeadContext> {
    const empty: LeadContext = {
      emailNormalized: null, phoneNormalized: null, city: null,
      clickId: null, clickIdType: null, ctwaClid: null, attributionCreatedAt: null,
    };
    if (!leadId) return empty;
    const [lead, attribution] = await Promise.all([
      this.prisma.lead.findUnique({ where: { id: leadId }, select: { emailNormalized: true, phoneNormalized: true, city: true } }),
      this.prisma.leadAttribution.findUnique({ where: { leadId }, select: { clickId: true, clickIdType: true, ctwaClid: true, createdAt: true } }),
    ]);
    return {
      emailNormalized: lead?.emailNormalized ?? null,
      phoneNormalized: lead?.phoneNormalized ?? null,
      city: lead?.city ?? null,
      clickId: attribution?.clickId ?? null,
      clickIdType: attribution?.clickIdType ?? null,
      ctwaClid: attribution?.ctwaClid ?? null,
      attributionCreatedAt: attribution?.createdAt ?? null,
    };
  }

  /** Meta Advanced-Matching user_data (SHA-256 em/ph/ct + fbc/ctwa_clid). */
  private metaUserData(ctx: LeadContext): CapiUserData {
    const out: CapiUserData = {};
    const em = sha256(ctx.emailNormalized);
    if (em) out.em = em;
    const ph = sha256(toE164Digits(ctx.phoneNormalized));
    if (ph) out.ph = ph;
    const ct = sha256(ctx.city);
    if (ct) out.ct = ct;
    if (ctx.clickIdType === 'FBCLID' && ctx.clickId && ctx.attributionCreatedAt) {
      const fbc = buildFbc(ctx.clickId, ctx.attributionCreatedAt);
      if (fbc) out.fbc = fbc;
    }
    if (ctx.ctwaClid) out.ctwa_clid = ctx.ctwaClid;
    return out;
  }

  private async markReauth(accountId: string): Promise<void> {
    await this.prisma.adAccount
      .update({ where: { id: accountId }, data: { status: 'TOKEN_EXPIRED', lastError: 'reauth_required' } })
      .catch(() => undefined);
  }
}
