import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { normalizeEmail, normalizePhone, localMsisdnVariants } from '../utils/lead-normalize';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';
import { ResolvedChannelConfig } from './channel-adapter.interface';

/** The `value` object of a Meta `leadgen` webhook change. */
export interface LeadgenChangeValue {
  leadgen_id: string;
  form_id?: string;
  ad_id?: string;
  adgroup_id?: string;
  campaign_id?: string;
  page_id?: string;
  created_time?: number | string;
}

/** The minimal channel shape the ingest needs (already resolved by the webhook controller). */
export interface LeadgenChannel {
  id: string;
  workspaceId: string;
  externalId: string | null;
}

/**
 * Meta Lead Ads (Instant Form) → CRM lead. A `leadgen` webhook change carries
 * only a `leadgen_id`; we fetch the full submission from the Graph API with the
 * Page token, flatten `field_data`, and create an ADS-source lead — mirroring
 * FormsService.submit internals but resolving the workspace from the channel
 * (there is no FormDef). Idempotent on Lead.externalRef='fbleadgen:<id>' because
 * Meta redelivers leadgen webhooks aggressively; best-effort throughout (the
 * webhook has already 200-ACKed by the time this runs).
 */
@Injectable()
export class MetaLeadgenIngestService {
  private readonly logger = new Logger(MetaLeadgenIngestService.name);
  private readonly sentinelCache = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly leadAttribution: LeadAttributionService,
  ) {}

  async ingest(
    channel: LeadgenChannel,
    config: ResolvedChannelConfig,
    value: LeadgenChangeValue,
  ): Promise<void> {
    const leadgenId = value?.leadgen_id ? String(value.leadgen_id) : null;
    if (!leadgenId) return;
    const workspaceId = channel.workspaceId;
    const externalRef = `fbleadgen:${leadgenId}`;

    // Idempotency pre-check: a redelivery of an already-ingested submission is a
    // cheap no-op (the create-time @@unique([workspaceId, externalRef]) + P2002
    // catch below is the race backstop for concurrent redeliveries).
    const dup = await this.prisma.lead.findFirst({
      where: { workspaceId, externalRef },
      select: { id: true },
    });
    if (dup) return;

    const token = config?.secrets?.pageAccessToken;
    if (!token) {
      this.logger.warn(`leadgen ${leadgenId}: no pageAccessToken on channel ${channel.id} — skipping`);
      return;
    }

    // Fetch the full submission. leads_retrieval/pages_manage_ads on the Page
    // token is required (App Review) — until then this returns an OAuthException
    // and we skip (best-effort, the webhook already ACKed).
    const r = await metaGraphFetch(`/${leadgenId}`, {
      accessToken: token,
      method: 'GET',
      query: { fields: 'field_data,form_id,ad_id,campaign_id,campaign_name,created_time' },
    });
    if (!r.ok) {
      this.logger.warn(`leadgen ${leadgenId} fetch failed: ${r.error?.message ?? r.status}`);
      return;
    }

    const fields = this.flatten(r.data?.field_data);
    const name = (
      fields.full_name ||
      [fields.first_name, fields.last_name].filter(Boolean).join(' ')
    ).trim();
    const email = (fields.email || '').trim() || null;
    const phone = (fields.phone_number || fields.phone || '').trim() || null;
    const emailNormalized = normalizeEmail(email);
    const phoneNormalized = normalizePhone(phone);
    const businessName = (fields.company_name || fields.company || name || 'Meta Lead Ad').trim();
    // The change value is the freshest ad linkage; fall back to the Graph body.
    const campaignRef =
      value.campaign_id ?? value.ad_id ?? r.data?.campaign_id ?? r.data?.ad_id ?? null;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Dedup on the NORMALIZED keys, skipping tombstoned/soft-deleted leads —
        // identical to the public-form path so a lead-ad and a website form from
        // the same person collide instead of duplicating.
        let existing: { id: string; status: string } | null = null;
        if (emailNormalized || phoneNormalized) {
          existing = await tx.lead.findFirst({
            where: {
              workspaceId,
              mergedIntoId: null,
              deletedAt: null,
              OR: [
                ...(emailNormalized ? [{ emailNormalized }] : []),
                // Match across every stored spelling (0- / bare / 90- / +90 / 00-)
                // like İYS/telephony/import do — Meta delivers E.164 (→ 90-prefixed)
                // while the same person's web form stored a 0-prefixed number, so an
                // exact match would miss it and duplicate the paid lead.
                ...(phoneNormalized ? [{ phoneNormalized: { in: localMsisdnVariants(phoneNormalized) } }] : []),
              ],
            },
            select: { id: true, status: true },
          });
        }
        if (existing) {
          // Re-engagement onto an existing contact — first-touch attribution is
          // immutable, so leave the lead (and its original source) untouched.
          // A later redelivery dedups here again: still a safe no-op.
          return;
        }

        const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
        const lead = await tx.lead.create({
          data: {
            workspaceId,
            businessName,
            contactPerson: name || businessName,
            businessType: 'OTHER',
            source: 'ADS',
            status: 'NEW',
            externalRef,
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(emailNormalized ? { emailNormalized } : {}),
            ...(phoneNormalized ? { phoneNormalized } : {}),
            ...(autoOwner ? { assignedToId: autoOwner } : {}),
          },
        });
        const sentinel = await this.resolveSentinel(workspaceId);
        if (sentinel) {
          await tx.leadActivity.create({
            data: {
              leadId: lead.id,
              type: 'NOTE',
              title: 'Meta Lead Ad submission',
              description: this.summarize(fields),
              createdById: sentinel,
            },
          });
        }
        await this.outbox.append(
          {
            type: MarketingEventTypes.LeadCreated,
            idempotencyKey: `lead-created:${lead.id}`,
            payload: { workspaceId, leadId: lead.id, source: 'ADS', occurredAt: new Date().toISOString() },
          },
          tx as any,
        );
        // First-touch attribution ties the lead to its sourcing ad campaign/ad.
        await this.leadAttribution.capture(
          workspaceId,
          lead.id,
          { fields },
          campaignRef ? { sourceAdCampaignId: String(campaignRef) } : {},
          tx,
        );
      });
    } catch (err: any) {
      // A concurrent redelivery that won the create surfaces here as a
      // (workspaceId, externalRef) unique violation — a quiet dedup no-op.
      if (err?.code === 'P2002') return;
      this.logger.error(`leadgen ${leadgenId} ingest failed: ${err?.message ?? err}`);
    }
  }

  /** Flatten Meta's `field_data` (Array<{name, values[]}>) to name → first value. */
  private flatten(fieldData: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(fieldData)) {
      for (const f of fieldData) {
        const k = (f as any)?.name;
        const v = Array.isArray((f as any)?.values) ? (f as any).values[0] : undefined;
        if (typeof k === 'string' && v != null) out[k] = String(v);
      }
    }
    return out;
  }

  private summarize(fields: Record<string, string>): string {
    return Object.entries(fields)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
      .join('\n')
      .slice(0, 2000);
  }

  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    if (this.sentinelCache.has(workspaceId)) return this.sentinelCache.get(workspaceId)!;
    const row = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, role: 'SYSTEM' },
      select: { id: true },
    });
    const id = row?.id ?? null;
    this.sentinelCache.set(workspaceId, id);
    return id;
  }
}
