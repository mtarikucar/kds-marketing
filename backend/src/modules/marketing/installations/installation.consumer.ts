import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  DomainEventBus,
  DomainEvent,
} from '../../outbox/domain-event-bus.service';
import {
  MarketingEventTypes,
  MarketingLeadConvertedPayload,
} from '../events/marketing-event-types';
import { InstallationJobService } from './installation-job.service';

/**
 * Phase 3: auto-create an installation job when a lead converts to a customer.
 * Reacts to marketing.lead.converted.v1 (emitted by both convert() and the
 * orphan-reconciliation sweep). Snapshots the site/contact from the
 * marketing-owned Lead so the job never reads core tables, and takes the
 * job's workspaceId from that same lead row — the event originates from a
 * lead in this service, so the lead IS the workspace-scope anchor. If the
 * lead can't be resolved, the job is skipped (warn) rather than minted
 * unscoped. Idempotent — one non-cancelled job per tenant (enforced in
 * createForConversion).
 */
@Injectable()
export class InstallationConsumer implements OnModuleInit {
  private readonly logger = new Logger(InstallationConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly jobs: InstallationJobService,
  ) {}

  onModuleInit(): void {
    this.bus.on(MarketingEventTypes.LeadConverted, (event) =>
      this.handle(event as DomainEvent<MarketingLeadConvertedPayload>),
    );
  }

  private async handle(event: DomainEvent<MarketingLeadConvertedPayload>): Promise<void> {
    const p = event.payload;
    try {
      if (!p.leadId) {
        this.logger.warn(
          `lead.converted event for tenant=${p.tenantId} carries no leadId — cannot resolve a workspace, skipping installation job`,
        );
        return;
      }
      // The lead row is the workspace anchor for the auto-created job
      // (findUnique by unguessable id; its workspaceId is authoritative).
      const lead = await this.prisma.lead.findUnique({
        where: { id: p.leadId },
        select: {
          workspaceId: true,
          contactPerson: true,
          phone: true,
          address: true,
          city: true,
        },
      });
      if (!lead) {
        this.logger.warn(
          `Lead ${p.leadId} not found for tenant=${p.tenantId} — skipping installation job`,
        );
        return;
      }
      const job = await this.jobs.createForConversion(lead.workspaceId, {
        tenantId: p.tenantId,
        leadId: p.leadId,
        contactName: lead.contactPerson,
        contactPhone: lead.phone,
        siteAddress: lead.address,
        siteCity: lead.city,
      });
      this.logger.log(
        `Installation job ready for tenant=${p.tenantId} (job=${job.id})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to auto-create installation job for tenant=${p.tenantId}: ${err?.message ?? err}`,
      );
    }
  }
}
