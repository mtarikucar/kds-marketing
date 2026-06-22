import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { MessageQuotaService } from '../channels/message-quota.service';

/**
 * Text-to-pay (GoHighLevel parity): send a contact the invoice's public pay link
 * over the workspace's SMS or WhatsApp channel. Reuses the exact reserve→send→
 * refund-on-failure path the campaign sender uses (the registry owns secret
 * decryption; the adapter never throws on a provider 4xx — it returns FAILED).
 * Sending a DRAFT marks it SENT so the pay link works.
 */
@Injectable()
export class InvoiceTextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly quota: MessageQuotaService,
  ) {}

  async sendByText(workspaceId: string, invoiceId: string, channelType: 'SMS' | 'WHATSAPP') {
    if (channelType !== 'SMS' && channelType !== 'WHATSAPP') {
      throw new BadRequestException('channel must be SMS or WHATSAPP');
    }
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, workspaceId },
      select: { id: true, publicToken: true, number: true, leadId: true, status: true, total: true, currency: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID' || inv.status === 'VOID') {
      throw new BadRequestException('Invoice is not payable');
    }
    if (!inv.leadId) throw new BadRequestException('Invoice has no contact to text');

    const lead = await this.prisma.lead.findFirst({
      where: { id: inv.leadId, workspaceId },
      select: { phone: true, whatsapp: true },
    });
    const to = channelType === 'WHATSAPP' ? lead?.whatsapp || lead?.phone : lead?.phone;
    if (!to) throw new BadRequestException('Contact has no phone number');

    const channel = await this.prisma.channel.findFirst({
      where: { workspaceId, type: channelType, status: 'ACTIVE' },
    });
    if (!channel || !this.registry.has(channelType)) {
      throw new BadRequestException(`No active ${channelType} channel is configured`);
    }

    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    const payUrl = `${base}/api/public/i/${inv.publicToken}`;
    const text = `Invoice ${inv.number}: ${payUrl}`;

    // reserve→send must be paired: refund the metered message if the send fails
    // OR the adapter throws, mirroring CampaignSenderService.
    await this.quota.reserve(workspaceId, channelType);
    try {
      const result = await this.registry
        .get(channelType)
        .send({ config: this.registry.resolveConfig(channel), to, text });
      if (result.status === 'FAILED') {
        await this.quota.refund(workspaceId, channelType);
        throw new BadRequestException(result.error ?? 'Message send failed');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      await this.quota.refund(workspaceId, channelType);
      throw new BadRequestException((e as Error)?.message ?? 'Message send failed');
    }

    // A DRAFT must become SENT so the public pay page resolves the link.
    if (inv.status === 'DRAFT') {
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'SENT' } });
    }
    return { sent: true, channel: channelType, payUrl };
  }
}
