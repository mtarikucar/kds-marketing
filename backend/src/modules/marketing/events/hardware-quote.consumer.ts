import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  DomainEventBus,
  DomainEvent,
} from "../../outbox/domain-event-bus.service";
import {
  MarketingEventTypes,
  MarketingHardwareQuotePayload,
} from "./marketing-event-types";
import { LeadAutoAssignerService } from "../services/lead-auto-assigner.service";
import { findCoreIntegratedWorkspaceId } from "../services/core-workspace.helper";
import { normalizeEmail, normalizePhone } from "../utils/lead-normalize";

/**
 * Creates a marketing Lead (source=HARDWARE_QUOTE) when the core catalog emits
 * `marketing.lead.hardware_quote.v1` — i.e. a tenant clicked "Teklif Al" on a
 * QUOTE_ONLY device (yazarkasa / YN ÖKC). Keeping the write here (not in the
 * catalog module) is the Phase-5 boundary: core never touches the `leads`
 * table directly.
 *
 * - Dedup: upsert on the deterministic externalRef so resubmits collapse into
 *   one lead (status + assignee preserved on update).
 * - Auto-assign: new leads are run through the distribution strategy, same as
 *   the AI-ingest path, so they don't sit unowned in the pool.
 */
@Injectable()
export class HardwareQuoteConsumer implements OnModuleInit {
  private readonly logger = new Logger(HardwareQuoteConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly autoAssigner: LeadAutoAssignerService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.HardwareQuoteRequested, (event) =>
      this.handle(event as DomainEvent<MarketingHardwareQuotePayload>),
    );
  }

  private async handle(
    event: DomainEvent<MarketingHardwareQuotePayload>,
  ): Promise<void> {
    const p = event.payload;
    try {
      // Core-originated event — no user context. Hardware quotes can only
      // come from the single core-integrated workspace; without one there
      // is nowhere safe to file the lead, so skip rather than guess.
      const workspaceId = await findCoreIntegratedWorkspaceId(this.prisma);
      if (!workspaceId) {
        this.logger.warn(
          `No core-integrated workspace — skipping hardware-quote lead for tenant=${p.tenantId} (ref=${p.dedupRef})`,
        );
        return;
      }
      // A resubmitted quote (same dedupRef) just refreshes the existing lead —
      // keep its owner + status. Crucially, do NOT call pickAssignee on this
      // path: under ROUND_ROBIN it advances the distribution cursor, so a tenant
      // re-clicking "Teklif Al" would silently consume rotation slots and skew
      // rep assignment without ever creating a lead. Auto-assign only for a
      // genuinely new lead.
      // Store the NORMALIZED phone/email like every other lead-create path, or
      // the lead is invisible to the dedup system (a later form/booking from the
      // same contact wouldn't match → a duplicate, and it never clusters in
      // findDuplicates). Recompute on the resubmit-refresh too — phone/email change.
      const updateData = {
        contactPerson: p.contactPerson,
        phone: p.phone,
        email: p.email,
        phoneNormalized: normalizePhone(p.phone),
        emailNormalized: normalizeEmail(p.email),
        notes: p.notes,
        productSnapshot: p.productSnapshot as any,
      };
      const existing = await this.prisma.lead.findFirst({
        where: { workspaceId, externalRef: p.dedupRef },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.lead.update({ where: { id: existing.id }, data: updateData });
        this.logger.log(
          `Hardware-quote lead refreshed for tenant=${p.tenantId} (ref=${p.dedupRef})`,
        );
        return;
      }

      const autoOwner = await this.autoAssigner.pickAssignee(workspaceId);
      // upsert (not create) stays as the concurrent-delivery race backstop: if a
      // sibling delivery created the row between the check above and here, this
      // collapses onto it via the (workspaceId, externalRef) unique.
      await this.prisma.lead.upsert({
        where: {
          workspaceId_externalRef: { workspaceId, externalRef: p.dedupRef },
        },
        create: {
          workspaceId,
          businessName: p.businessName,
          contactPerson: p.contactPerson,
          phone: p.phone,
          email: p.email,
          phoneNormalized: normalizePhone(p.phone),
          emailNormalized: normalizeEmail(p.email),
          businessType: "OTHER",
          source: "HARDWARE_QUOTE",
          notes: p.notes,
          originTenantId: p.tenantId,
          productSnapshot: p.productSnapshot as any,
          externalRef: p.dedupRef,
          ...(autoOwner ? { assignedToId: autoOwner } : {}),
        },
        update: updateData,
      });
      this.logger.log(
        `Hardware-quote lead ready for tenant=${p.tenantId} (ref=${p.dedupRef})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to create hardware-quote lead for tenant=${p.tenantId}: ${err?.message ?? err}`,
      );
    }
  }
}
