import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DomainEventBus, DomainEvent } from '../../outbox/domain-event-bus.service';

export const SLACK_EVENTS = [
  'marketing.lead.created.v1',
  'marketing.lead.converted.v1',
  'marketing.form.submitted.v1',
  'marketing.booking.created.v1',
];

interface SlackInput {
  webhookUrl: string;
  channel?: string;
  events?: string[];
}

/**
 * Epic B4 — Slack notifications via incoming webhooks (no OAuth). Subscribes to
 * a whitelist of domain events and POSTs a formatted message to each ACTIVE
 * integration whose `events` matches. Best-effort; never throws into the bus.
 */
@Injectable()
export class SlackService implements OnModuleInit {
  private readonly logger = new Logger(SlackService.name);

  constructor(
    private prisma: PrismaService,
    private bus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    for (const t of SLACK_EVENTS) this.bus.on(t, (e) => this.fanOut(e));
  }

  async fanOut(event: DomainEvent): Promise<void> {
    const workspaceId = (event.payload as { workspaceId?: string })?.workspaceId;
    if (!workspaceId) return;
    const integrations = await this.prisma.slackIntegration.findMany({
      where: { workspaceId, status: 'ACTIVE' },
    });
    const text = this.format(event);
    for (const intg of integrations) {
      const subscribed = (intg.events as string[]) ?? [];
      if (subscribed.length && !subscribed.includes(event.type)) continue;
      const ok = await this.post(intg.webhookUrl, text);
      if (ok) {
        await this.prisma.slackIntegration
          .update({ where: { id: intg.id }, data: { lastNotifiedAt: new Date() } })
          .catch(() => undefined);
      }
    }
  }

  private format(event: DomainEvent): string {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'marketing.lead.created.v1':
        return `:new: New lead created${p.source ? ` (source: ${p.source})` : ''}`;
      case 'marketing.lead.converted.v1':
        return ':moneybag: A lead converted to a customer!';
      case 'marketing.form.submitted.v1':
        return ':inbox_tray: New form submission';
      case 'marketing.booking.created.v1':
        return ':calendar: New booking created';
      default:
        return `Event: ${event.type}`;
    }
  }

  private async post(url: string, text: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (e) {
      this.logger.warn(`Slack post failed: ${(e as Error).message}`);
      return false;
    }
  }

  // ---- management -------------------------------------------------------

  private mask(i: { id: string; channel: string | null; events: unknown; status: string; lastNotifiedAt: Date | null; createdAt: Date }) {
    return {
      id: i.id,
      channel: i.channel,
      events: i.events,
      status: i.status,
      lastNotifiedAt: i.lastNotifiedAt,
      createdAt: i.createdAt,
    };
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.slackIntegration.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mask(r));
  }

  async create(workspaceId: string, dto: SlackInput) {
    const row = await this.prisma.slackIntegration.create({
      data: {
        workspaceId,
        webhookUrl: dto.webhookUrl,
        channel: dto.channel,
        events: (dto.events ?? []) as Prisma.InputJsonValue,
      },
    });
    return this.mask(row);
  }

  private async owned(workspaceId: string, id: string) {
    const i = await this.prisma.slackIntegration.findFirst({ where: { id, workspaceId } });
    if (!i) throw new NotFoundException('Slack integration not found');
    return i;
  }

  async update(workspaceId: string, id: string, dto: Partial<SlackInput> & { status?: string }) {
    await this.owned(workspaceId, id);
    const row = await this.prisma.slackIntegration.update({
      where: { id },
      data: {
        ...(dto.webhookUrl !== undefined && { webhookUrl: dto.webhookUrl }),
        ...(dto.channel !== undefined && { channel: dto.channel }),
        ...(dto.events !== undefined && { events: dto.events as Prisma.InputJsonValue }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
    return this.mask(row);
  }

  async remove(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    await this.prisma.slackIntegration.delete({ where: { id } });
    return { id };
  }

  async test(workspaceId: string, id: string) {
    const i = await this.owned(workspaceId, id);
    const ok = await this.post(i.webhookUrl, ':wave: Test notification from kds-marketing');
    return { ok };
  }
}
