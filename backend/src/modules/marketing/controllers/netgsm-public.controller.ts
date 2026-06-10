import { Controller, Post, Body, Logger } from '@nestjs/common';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';

/**
 * NetGSM delivery-report (DLR) callback. NetGSM POSTs delivery outcomes keyed
 * by the job id we recorded as the outbound Message's externalMessageId, so we
 * flip the message's status. NetGSM doesn't sign callbacks (it's IP-allowlisted
 * on their side); we accept tolerantly and only ever touch a message whose
 * globally-unique job id matches. DLR shapes vary by account, so we read a few
 * common key spellings.
 */
@Controller('public/channels/netgsm')
export class NetgsmPublicController {
  private readonly logger = new Logger(NetgsmPublicController.name);

  constructor(private readonly resolver: PublicChannelResolverService) {}

  @Post('dlr')
  async dlr(@Body() body: any): Promise<{ ok: boolean; updated: number }> {
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? body?.report ?? [body]);
    let updated = 0;
    for (const r of rows) {
      const jobId = r?.jobid ?? r?.bulkid ?? r?.id;
      if (!jobId) continue;
      const status = this.mapStatus(String(r?.status ?? r?.durum ?? ''));
      updated += await this.resolver.markDeliveryStatus(String(jobId), status);
    }
    return { ok: true, updated };
  }

  /** NetGSM delivery codes → our Message.status. 1 = delivered; 2-4 = failed. */
  private mapStatus(code: string): string {
    if (code === '1') return 'DELIVERED';
    if (['2', '3', '4', '11', '12'].includes(code)) return 'FAILED';
    return 'SENT';
  }
}
