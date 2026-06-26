import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';

/**
 * Child delegates whose rows carry a `leadId` and are re-parented wholesale on
 * merge. They are accessed dynamically (bracket form) because the operation is
 * uniform across all of them; multi-tenant isolation is guaranteed not by a
 * per-table `workspaceId` filter but by the fact that `dupIds` are resolved
 * through a workspace-scoped read BEFORE any re-parent runs (see `merge`).
 * LeadTag and CampaignRecipient are handled separately (uniqueness collisions).
 */
const SIMPLE_CHILD_DELEGATES = [
  'leadActivity',
  'marketingTask',
  'leadOffer',
  'commission',
  'salesCall',
  'installationJob',
  'contactIdentity',
  'conversation',
  'workflowRun',
  'booking',
  'review',
  'voiceCall',
  'invoice',
  // Lead-owned records added with later features. They are pure 1:N (no unique
  // constraint involving leadId), so a wholesale re-parent can't collide. Before
  // this, merging a duplicate ORPHANED these on the tombstoned (query-hidden) row
  // — the canonical lost the dup's deals, documents, estimates, consent, etc.
  'opportunity',
  'document',
  'estimate',
  'triggerLinkClick',
  'dialSessionItem',
  'dataRequest',
  'surveyResponse',
  'consentRecord',
  'customerSubscription',
  'couponRedemption',
  // NOTE: collision-keyed [<field>, leadId] children (enrollment, customObjectLink,
  // communityMember, earnedBadge, certificate) are re-parented via reparentDeduped()
  // in merge(). Still deferred — they need bespoke handling, not a naive move:
  //   • pointsLedger — unique [workspaceId, leadId, source, refId] (composite
  //     collision key, not a single field reparentDeduped handles)
  //   • customerWallet — unique [workspaceId, leadId] (one per lead) needs a
  //     SEMANTIC balance merge (sum the dup's balance into the canonical's), not
  //     a move/drop.
] as const;

/** Scalar fields filled onto the canonical from a duplicate when blank. */
const FILLABLE_FIELDS = [
  'phone',
  'whatsapp',
  'email',
  'address',
  'city',
  'region',
  'contactPerson',
  'businessType',
  'currentSystem',
  'notes',
] as const;

export interface Cluster {
  suggestedCanonicalId: string;
  leads: { id: string; [k: string]: unknown }[];
}

@Injectable()
export class LeadDedupeService {
  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
  ) {}

  /** Group active leads sharing a normalized phone or email into clusters. */
  async findDuplicates(workspaceId: string): Promise<Cluster[]> {
    const leads = await this.prisma.lead.findMany({
      where: {
        workspaceId,
        mergedIntoId: null,
        OR: [
          { phoneNormalized: { not: null } },
          { emailNormalized: { not: null } },
        ],
      },
      select: {
        id: true,
        businessName: true,
        contactPerson: true,
        phone: true,
        email: true,
        phoneNormalized: true,
        emailNormalized: true,
        status: true,
        convertedTenantId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Union-find over shared phone/email keys.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) ?? r;
      return r;
    };
    const union = (x: string, y: string) => {
      parent.set(find(x), find(y));
    };
    for (const l of leads) parent.set(l.id, l.id);

    const byKey = (sel: (l: (typeof leads)[number]) => string | null) => {
      const groups = new Map<string, string[]>();
      for (const l of leads) {
        const k = sel(l);
        if (!k) continue;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(l.id);
      }
      for (const ids of groups.values()) {
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
      }
    };
    byKey((l) => l.phoneNormalized);
    byKey((l) => l.emailNormalized);

    const components = new Map<string, typeof leads>();
    for (const l of leads) {
      const root = find(l.id);
      (components.get(root) ?? components.set(root, []).get(root)!).push(l);
    }

    const clusters: Cluster[] = [];
    for (const group of components.values()) {
      if (group.length < 2) continue;
      const converted = group.find((l) => l.convertedTenantId);
      const suggestedCanonicalId = (converted ?? group[0]).id; // group is createdAt-asc
      clusters.push({ suggestedCanonicalId, leads: group });
    }
    return clusters;
  }

  async merge(
    workspaceId: string,
    canonicalId: string,
    duplicateIds: string[],
  ): Promise<{ canonicalId: string; merged: number }> {
    if (duplicateIds.includes(canonicalId)) {
      throw new BadRequestException('Canonical lead cannot also be a duplicate');
    }

    // Resolve EVERYTHING in-workspace first — this scoped read is what makes the
    // subsequent (workspace-filter-less) child re-parents safe.
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: [canonicalId, ...duplicateIds] }, workspaceId },
    });
    const canonical = leads.find((l) => l.id === canonicalId);
    if (!canonical) throw new NotFoundException('Canonical lead not found');
    if (canonical.mergedIntoId) {
      throw new BadRequestException('Canonical lead is itself merged');
    }

    const dups = leads.filter((l) => l.id !== canonicalId && !l.mergedIntoId);
    if (dups.some((d) => d.convertedTenantId)) {
      throw new ConflictException(
        'Cannot merge a converted lead as a duplicate — make it the canonical instead',
      );
    }
    const dupIds = dups.map((d) => d.id);
    if (dupIds.length === 0) return { canonicalId, merged: 0 };

    await this.prisma.$transaction(async (tx) => {
      const txc = tx as unknown as Record<string, any>;

      for (const delegate of SIMPLE_CHILD_DELEGATES) {
        await txc[delegate].updateMany({
          where: { leadId: { in: dupIds } },
          data: { leadId: canonicalId },
        });
      }

      // LeadTag — composite PK [leadId, tagId]: drop dup links the canonical
      // already has, then move the rest.
      const canonTags: { tagId: string }[] = await txc.leadTag.findMany({
        where: { leadId: canonicalId },
        select: { tagId: true },
      });
      const canonTagIds = canonTags.map((t) => t.tagId);
      if (canonTagIds.length) {
        await txc.leadTag.deleteMany({
          where: { leadId: { in: dupIds }, tagId: { in: canonTagIds } },
        });
      }
      await txc.leadTag.updateMany({
        where: { leadId: { in: dupIds } },
        data: { leadId: canonicalId },
      });

      // CampaignRecipient — unique [campaignId, leadId]: same collision dance.
      const canonRcpts: { campaignId: string }[] = await txc.campaignRecipient.findMany({
        where: { leadId: canonicalId, workspaceId },
        select: { campaignId: true },
      });
      const canonCampaignIds = canonRcpts.map((r) => r.campaignId);
      if (canonCampaignIds.length) {
        await txc.campaignRecipient.deleteMany({
          where: { leadId: { in: dupIds }, campaignId: { in: canonCampaignIds }, workspaceId },
        });
      }
      await txc.campaignRecipient.updateMany({
        where: { leadId: { in: dupIds }, workspaceId },
        data: { leadId: canonicalId },
      });

      // Children with a [<field>, leadId] unique — same collision dance, so a
      // duplicate enrolled in / certified for / a member/badge-holder of the SAME
      // course/community/badge as the canonical doesn't abort the merge on P2002.
      // (workspaceId is part of the unique for earnedBadge/certificate.)
      await this.reparentDeduped(txc, 'enrollment', 'courseId', canonicalId, dupIds);
      await this.reparentDeduped(txc, 'customObjectLink', 'recordId', canonicalId, dupIds);
      await this.reparentDeduped(txc, 'communityMember', 'communityId', canonicalId, dupIds);
      await this.reparentDeduped(txc, 'earnedBadge', 'badgeId', canonicalId, dupIds, { workspaceId });
      await this.reparentDeduped(txc, 'certificate', 'courseId', canonicalId, dupIds, { workspaceId });

      // Union custom fields (canonical wins per key) + fill blank scalars.
      const customFields = this.mergeCustomFields(canonical, dups);
      const filled = this.fillBlanks(canonical, dups);
      await tx.lead.update({
        where: { id: canonicalId },
        data: { customFields: customFields as Prisma.InputJsonValue, ...filled },
      });

      // Tombstone the duplicates (explicitly workspace-scoped). The
      // `convertedTenantId: null` claim closes the TOCTOU against a convert()
      // racing between the pre-check above and here: a dup converted in the
      // meantime is NOT tombstoned, and the count mismatch aborts the whole
      // merge (the tx rolls back the child re-parenting too).
      const tombstone = await tx.lead.updateMany({
        where: { id: { in: dupIds }, workspaceId, convertedTenantId: null },
        data: { mergedIntoId: canonicalId, mergedAt: new Date() },
      });
      if (tombstone.count !== dupIds.length) {
        throw new ConflictException(
          'A duplicate was converted during the merge — refresh and retry',
        );
      }

      await this.outbox.append(
        {
          type: 'marketing.lead.merged.v1',
          idempotencyKey: `lead-merged:${canonicalId}:${[...dupIds].sort().join(',')}`,
          payload: { workspaceId, canonicalId, mergedIds: dupIds },
        },
        tx,
      );
    });

    return { canonicalId, merged: dupIds.length };
  }

  /**
   * Re-parent a child whose uniqueness is `[<collisionField>, leadId]` (optionally
   * within `scope`, e.g. workspaceId). A naive wholesale move would hit that unique
   * and throw P2002 — aborting the entire merge — whenever the canonical already
   * owns a row for the same collisionField (e.g. both leads enrolled in the same
   * course). So drop the colliding duplicate rows first, then move the rest.
   * Mirrors the inline LeadTag / CampaignRecipient dance.
   */
  private async reparentDeduped(
    txc: Record<string, any>,
    delegate: string,
    collisionField: string,
    canonicalId: string,
    dupIds: string[],
    scope: Record<string, unknown> = {},
  ): Promise<void> {
    const canonRows: Record<string, any>[] = await txc[delegate].findMany({
      where: { leadId: canonicalId, ...scope },
      select: { [collisionField]: true },
    });
    const collisionVals = canonRows.map((r) => r[collisionField]);
    if (collisionVals.length) {
      await txc[delegate].deleteMany({
        where: { leadId: { in: dupIds }, [collisionField]: { in: collisionVals }, ...scope },
      });
    }
    await txc[delegate].updateMany({
      where: { leadId: { in: dupIds }, ...scope },
      data: { leadId: canonicalId },
    });
  }

  private mergeCustomFields(
    canonical: { customFields: unknown },
    dups: { customFields: unknown }[],
  ): Record<string, unknown> {
    let acc: Record<string, unknown> = {};
    for (const d of dups) {
      acc = { ...acc, ...((d.customFields as Record<string, unknown>) ?? {}) };
    }
    return { ...acc, ...((canonical.customFields as Record<string, unknown>) ?? {}) };
  }

  private fillBlanks(
    canonical: Record<string, any>,
    dups: Record<string, any>[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of FILLABLE_FIELDS) {
      const cur = canonical[f];
      if (cur === null || cur === undefined || cur === '') {
        const donor = dups.find((d) => d[f] !== null && d[f] !== undefined && d[f] !== '');
        if (donor) out[f] = donor[f];
      }
    }
    if ('phone' in out) out.phoneNormalized = normalizePhone(out.phone as string);
    if ('email' in out) out.emailNormalized = normalizeEmail(out.email as string);
    return out;
  }
}
