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
      // Auto-assign only matters for a brand-new lead; on an existing
      // (resubmitted) lead we keep the current owner + status untouched.
      const autoOwner = await this.autoAssigner.pickAssignee(workspaceId);
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
          businessType: "OTHER",
          source: "HARDWARE_QUOTE",
          notes: p.notes,
          originTenantId: p.tenantId,
          productSnapshot: p.productSnapshot as any,
          externalRef: p.dedupRef,
          ...(autoOwner ? { assignedToId: autoOwner } : {}),
        },
        update: {
          contactPerson: p.contactPerson,
          phone: p.phone,
          email: p.email,
          notes: p.notes,
          productSnapshot: p.productSnapshot as any,
        },
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
