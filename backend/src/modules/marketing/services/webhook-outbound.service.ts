import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
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

  // ---- management (workspace realm) -------------------------------------

  private readonly ENDPOINT_PUBLIC = {
    id: true,
    url: true,
    events: true,
    description: true,
    status: true,
    failureCount: true,
    lastDeliveryAt: true,
    createdAt: true,
  } as const;

  private validateEvents(events: string[]): void {
    const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
    if (bad.length) {
      throw new BadRequestException(`Unsupported event type(s): ${bad.join(', ')}`);
    }
  }

  async createEndpoint(
    workspaceId: string,
    input: { url: string; events?: string[]; description?: string },
    createdById?: string,
  ) {
    const events = input.events ?? [];
    this.validateEvents(events);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const ep = await this.prisma.webhookEndpoint.create({
      data: {
        workspaceId,
        url: input.url,
        events,
        description: input.description,
        secret,
        createdById: createdById ?? null,
      },
    });
    // secret returned exactly once
    return { id: ep.id, url: ep.url, events: ep.events, status: ep.status, secret };
  }

  listEndpoints(workspaceId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: this.ENDPOINT_PUBLIC,
    });
  }

  private async getOwnedEndpoint(workspaceId: string, id: string) {
    const ep = await this.prisma.webhookEndpoint.findFirst({ where: { id, workspaceId } });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    return ep;
  }

  async updateEndpoint(
    workspaceId: string,
    id: string,
    input: { url?: string; events?: string[]; description?: string; status?: string },
  ) {
    await this.getOwnedEndpoint(workspaceId, id);
    if (input.events) this.validateEvents(input.events);
    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(input.url !== undefined && { url: input.url }),
        ...(input.events !== undefined && { events: input.events }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.status !== undefined && { status: input.status, ...(input.status === 'ACTIVE' && { failureCount: 0 }) }),
      },
      select: this.ENDPOINT_PUBLIC,
    });
  }

  async removeEndpoint(workspaceId: string, id: string) {
    await this.getOwnedEndpoint(workspaceId, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    return { id };
  }

  async listDeliveries(workspaceId: string, endpointId: string) {
    await this.getOwnedEndpoint(workspaceId, endpointId);
    return this.prisma.webhookDelivery.findMany({
      where: { workspaceId, endpointId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async sendTest(workspaceId: string, id: string) {
    const ep = await this.getOwnedEndpoint(workspaceId, id);
    const eventId = `test_${randomBytes(8).toString('hex')}`;
    const delivery = await this.prisma.webhookDelivery.create({
      data: { workspaceId, endpointId: ep.id, eventId, eventType: 'marketing.webhook.test.v1' },
      select: { id: true },
    });
    await this.scheduledJob.schedule({
      workspaceId,
      kind: 'webhook.deliver',
      runAt: new Date(),
      payload: {
        deliveryId: delivery.id,
        event: { id: eventId, type: 'marketing.webhook.test.v1', payload: { workspaceId, message: 'test event' } },
      },
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    });
    return { deliveryId: delivery.id, status: 'QUEUED' };
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
