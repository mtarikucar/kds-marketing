import { AttributionInput, ParsedAttribution, pickParams } from './attribution-capture.util';

/**
 * D10a/D10c — deterministic click→campaign resolution (v1, no fuzzy matching).
 *
 * Fills the soft source refs a caller couldn't supply, from the click signals
 * alone:
 *  - `jg_cid` (our OWN link-decorator param carrying the ad campaign id) is
 *    trusted directly → `sourceAdCampaignId`. No lookup: the param is minted by
 *    us, and metrics for a brand-new campaign may not have been pulled yet.
 *  - otherwise a `utm_campaign` that EXACTLY matches a workspace
 *    `AdMetric.campaignId` → `sourceAdCampaignId` (ONE indexed lookup,
 *    workspace-scoped).
 *  - `utm_source=social` + `jg_pid` (our post-share decorator) →
 *    `sourceSocialPostId` (D10c).
 *
 * Bare click-ids (fbclid/gclid/…) without UTM/jg params stay
 * stored-but-unresolved by design — no fragile provider API lookups in v1.
 * Pure module (no DI): the caller hands in its Prisma client / tx so the ref
 * write stays enrolled in the lead's transaction. Best-effort by contract —
 * the caller must swallow resolver failures, never block lead creation.
 */

/** The one query the resolver needs — satisfied by PrismaService and any tx. */
export interface AttributionRefDb {
  adMetric: {
    findFirst(args: {
      where: { workspaceId: string; campaignId: string };
      select: { campaignId: true };
    }): Promise<{ campaignId: string } | null>;
  };
}

export interface ResolvedAttributionRefs {
  sourceAdCampaignId?: string;
  sourceSocialPostId?: string;
}

export async function resolveAttributionRefs(
  db: AttributionRefDb,
  workspaceId: string,
  input: AttributionInput,
  parsed: ParsedAttribution | null,
  existing: { sourceAdCampaignId?: string | null; sourceSocialPostId?: string | null },
): Promise<ResolvedAttributionRefs> {
  const out: ResolvedAttributionRefs = {};
  const params = pickParams(input, ['jg_cid', 'jg_pid']);

  // (a) ad campaign — only when the caller didn't already know the source.
  if (!existing.sourceAdCampaignId) {
    if (params.jg_cid) {
      out.sourceAdCampaignId = params.jg_cid;
    } else if (parsed?.utmCampaign) {
      const hit = await db.adMetric.findFirst({
        where: { workspaceId, campaignId: parsed.utmCampaign },
        select: { campaignId: true },
      });
      if (hit) out.sourceAdCampaignId = parsed.utmCampaign;
    }
  }

  // (c) social organic post ref — requires the explicit utm_source=social lane.
  if (
    !existing.sourceSocialPostId &&
    params.jg_pid &&
    (parsed?.utmSource ?? '').toLowerCase() === 'social'
  ) {
    out.sourceSocialPostId = params.jg_pid;
  }

  return out;
}
