import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService,
  ClaimedJob,
} from '../scheduling/scheduled-job-runner.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';

/** Domain event types an endpoint may subscribe to. */
export const WEBHOOK_EVENTS = [
  'marketing.lead.created.v1',
  'marketing.lead.converted.v1',
  'marketing.lead.merged.v1',
  'marketing.lead.customField.changed.v1',
  'marketing.lead.tag.added.v1',
  'marketing.lead.tag.removed.v1',
];

const WEBHOOK_MAX_ATTEMPTS = 6;
const DISABLE_THRESHOLD = 10;

interface DeliverPayload {
  deliveryId: string;
  event: { id: string; type: string; payload: unknown };
}

/**
 * Epic B2 — fans domain events out to workspace webhook endpoints and delivers
 * them with an HMAC-SHA256 signature, retrying via the ScheduledJob queue. Each
 * (event × endpoint) is one `WebhookDelivery` row (the established consumer
 * retry pattern referenced by DomainEventBus). The full event travels in the
 * job payload so a delivery is self-contained.
 */
@Injectable()
export class WebhookOutboundService implements OnModuleInit {
  private readonly logger = new Logger(WebhookOutboundService.name);

  constructor(
    private prisma: PrismaService,
    private scheduledJob: ScheduledJobService,
    private runner: ScheduledJobRunnerService,
    private bus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    for (const type of WEBHOOK_EVENTS) {
      this.bus.on(type, (e) => this.fanOut(e));
    }
    this.runner.registerHandler('webhook.deliver', (job: ClaimedJob) =>
      this.deliverOne(job.payload as DeliverPayload, job.attempts),
    );
  }

  async fanOut(event: DomainEvent): Promise<void> {
    const workspaceId = (event.payload as { workspaceId?: string })?.workspaceId;
    if (!workspaceId) return;
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { workspaceId, status: 'ACTIVE' },
    });
    for (const ep of endpoints) {
      const subscribed = (ep.events as string[]) ?? [];
      if (subscribed.length && !subscribed.includes(event.type)) continue;
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          workspaceId,
          endpointId: ep.id,
          eventId: event.id,
          eventType: event.type,
        },
        select: { id: true },
      });
      await this.scheduledJob.schedule({
        workspaceId,
        kind: 'webhook.deliver',
        runAt: new Date(),
        payload: {
          deliveryId: delivery.id,
          event: { id: event.id, type: event.type, payload: event.payload },
        } as Prisma.InputJsonValue,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      });
    }
  }

  private sign(secret: string, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  async deliverOne(payload: DeliverPayload, attempts: number): Promise<void> {
    const { deliveryId, event } = payload;
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
    });
    if (!delivery || delivery.status !== 'PENDING') return;

    const ep = await this.prisma.webhookEndpoint.findUnique({
      where: { id: delivery.endpointId },
    });
    if (!ep || ep.status !== 'ACTIVE') {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'FAILED', attempts: attempts + 1, error: 'endpoint inactive' },
      });
      return;
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      data: event.payload,
      deliveredAt: new Date().toISOString(),
    });
    const signature = this.sign(ep.secret, body);

    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-event': event.type,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SUCCESS',
          responseCode: res.status,
          attempts: attempts + 1,
          deliveredAt: new Date(),
        },
      });
      await this.prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { lastDeliveryAt: new Date(), failureCount: 0 },
      });
    } catch (e) {
      const next = attempts + 1;
      const message = (e as Error).message;
      if (next >= WEBHOOK_MAX_ATTEMPTS) {
        await this.prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: { status: 'FAILED', attempts: next, error: message },
        });
        const updated = await this.prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { failureCount: { increment: 1 } },
        });
        if (updated.failureCount >= DISABLE_THRESHOLD) {
          await this.prisma.webhookEndpoint.update({
            where: { id: ep.id },
            data: { status: 'DISABLED' },
          });
        }
        return; // terminal — job DONE, no DLQ noise
      }
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { attempts: next, error: message },
      });
      throw e; // let the ScheduledJob runner retry with backoff
    }
  }
}
