import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AttributionInput,
  ParsedAttribution,
  parseAttribution,
} from './attribution-capture.util';
import { resolveAttributionRefs } from './ad-campaign-resolver';

/** Soft content/campaign/ad references, resolved by the caller when known. */
export interface AttributionSource {
  sourceSocialPostId?: string | null;
  sourceCampaignItemId?: string | null;
  sourceSocialCampaignId?: string | null;
  sourceAdCampaignId?: string | null;
  sourceAdCreativeId?: string | null;
}

/**
 * First-touch lead attribution (Faz 0). Idempotent per lead: the first write
 * wins, so a re-engagement submission never overwrites the original touch.
 * Best-effort by contract — the caller must never let an attribution failure
 * block lead capture, so `capture()` swallows and logs its own errors.
 */
@Injectable()
export class LeadAttributionService {
  private readonly logger = new Logger(LeadAttributionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse the raw signals and, if any attribution is present, persist a
   * first-touch row for `leadId`. Pass `tx` to enrol in the caller's
   * transaction (recommended — the row is then as durable as the lead).
   */
  async capture(
    workspaceId: string,
    leadId: string,
    input: AttributionInput,
    source: AttributionSource = {},
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const parsed = parseAttribution(input);
    let src = this.cleanSource(source);
    const db = tx ?? this.prisma;
    // D10a/D10c: deterministically resolve the soft refs the caller couldn't
    // supply (explicit jg_cid, AdMetric-verified utm_campaign, social jg_pid).
    // Caller-known refs always win. Best-effort — a resolver failure only
    // costs the ref, never the attribution row or the lead.
    try {
      const resolved = await resolveAttributionRefs(db, workspaceId, input, parsed, src);
      src = { ...resolved, ...src };
    } catch (err) {
      this.logger.warn(`attribution ref resolution failed for lead ${leadId}: ${String((err as Error)?.message ?? err)}`);
    }
    // Nothing to record — neither click/UTM signal nor a known content source.
    if (!parsed && Object.keys(src).length === 0) return;
    try {
      await this.write(workspaceId, leadId, parsed, src, input, db);
    } catch (err) {
      this.logger.warn(`lead attribution capture failed for lead ${leadId}: ${String((err as Error)?.message ?? err)}`);
    }
  }

  private cleanSource(source: AttributionSource): AttributionSource {
    const out: AttributionSource = {};
    for (const [k, v] of Object.entries(source)) {
      if (v != null && v !== '') (out as Record<string, string>)[k] = String(v);
    }
    return out;
  }

  private async write(
    workspaceId: string,
    leadId: string,
    parsed: ParsedAttribution | null,
    src: AttributionSource,
    input: AttributionInput,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const create: Prisma.LeadAttributionCreateInput = {
      workspaceId,
      lead: { connect: { id: leadId } },
      ...(parsed ?? {}),
      ...src,
      raw: this.rawSnapshot(input, parsed, src),
    };
    // First-touch wins: create if absent, otherwise leave the original intact.
    await db.leadAttribution.upsert({ where: { leadId }, create, update: {} });
  }

  /** A compact forensic snapshot for late/debug attribution. */
  private rawSnapshot(input: AttributionInput, parsed: ParsedAttribution | null, src: AttributionSource): Prisma.InputJsonValue {
    return {
      url: input.url ?? null,
      referrer: input.referrer ?? null,
      ctwaClid: input.ctwaClid ?? null,
      parsed: (parsed ?? {}) as Prisma.InputJsonValue,
      source: src as Prisma.InputJsonValue,
    } as Prisma.InputJsonValue;
  }
}
