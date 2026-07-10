import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { WorkflowExecutorService } from './workflow-executor.service';
import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';
import { TRIGGER_TYPES, WorkflowTriggerType } from './workflow-dsl.schema';

/** DSL trigger type → the marketing domain-event that fires it. */
const EVENT_FOR_TRIGGER: Record<WorkflowTriggerType, string> = {
  'lead.created': MarketingEventTypes.LeadCreated,
  'lead.status_changed': MarketingEventTypes.LeadStatusChanged,
  'form.submitted': MarketingEventTypes.FormSubmitted,
  'conversation.message.received': MarketingEventTypes.ConversationMessageReceived,
  'booking.created': MarketingEventTypes.BookingCreated,
  'review.received': MarketingEventTypes.ReviewReceived,
  'task.completed': MarketingEventTypes.TaskCompleted,
  'tag.added': MarketingEventTypes.LeadTagAdded,
  'opportunity.created': MarketingEventTypes.OpportunityCreated,
  'opportunity.stage_changed': MarketingEventTypes.OpportunityStageChanged,
  'opportunity.won': MarketingEventTypes.OpportunityWon,
  'opportunity.lost': MarketingEventTypes.OpportunityLost,
  'link.clicked': MarketingEventTypes.LinkClicked,
  'webhook.received': MarketingEventTypes.WebhookReceived,
  'certificate.issued': MarketingEventTypes.CertificateIssued,
  'voice_keypress': MarketingEventTypes.VoiceKeypress,
};

/**
 * Listens to the marketing domain events that back each DSL trigger type and
 * starts every ACTIVE workflow whose trigger matches (type + filters). The
 * executor's partial-unique guard makes a duplicate start a no-op, and the bus
 * swallows listener errors — a started run is durable (ScheduledJob-backed), so
 * losing the trigger eval itself is the only at-risk step (logged, best-effort,
 * same contract as every other bus consumer).
 */
@Injectable()
export class WorkflowTriggerService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly executor: WorkflowExecutorService,
    private readonly handler: WorkflowActionHandler,
  ) {}

  onModuleInit(): void {
    for (const triggerType of TRIGGER_TYPES) {
      const eventName = EVENT_FOR_TRIGGER[triggerType];
      this.bus.on(eventName, (event) => this.onEvent(triggerType, event));
    }
  }

  private async onEvent(triggerType: WorkflowTriggerType, event: DomainEvent): Promise<void> {
    try {
      const p = (event.payload ?? {}) as Record<string, any>;
      const workspaceId: string | undefined = p.workspaceId ?? event.tenantId ?? undefined;
      if (!workspaceId) return;

      const workflows = await this.prisma.workflow.findMany({
        where: { workspaceId, status: 'ACTIVE' },
      });
      const candidates = workflows.filter((w) => (w.trigger as any)?.type === triggerType);
      if (candidates.length === 0) return;

      const subject = { leadId: p.leadId ?? null, conversationId: p.conversationId ?? null };
      const lead = subject.leadId
        ? await this.prisma.lead.findFirst({ where: { id: subject.leadId, workspaceId } })
        : null;
      const ctx: WorkflowContext = { workspaceId, lead, trigger: p, context: { _trigger: p } };

      for (const wf of candidates) {
        const filters = (wf.trigger as any)?.filters ?? [];
        if (!this.handler.matchesAll(filters, ctx)) continue;
        await this.executor
          .start(wf as any, subject, p, 0)
          .catch((e) => this.logger.error(`workflow ${wf.id} start failed: ${e?.message ?? e}`));
      }
    } catch (e: any) {
      this.logger.error(`workflow trigger (${triggerType}) failed: ${e?.message ?? e}`);
    }
  }
}
