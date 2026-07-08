import { Body, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { payloadDigest, verifyNetgsmWebhookToken } from './netgsm-webhook.util';

/**
 * Unified public receiver for NetGSM pushes (santral events, İYS, voice/
 * autocall reports). NetGSM signs nothing, so the URL carries an HMAC token
 * only MARKETING_SECRET_KEY holders can mint. Phase 0: verify + archive +
 * dedupe (202). Domain consumers (screen-pop, CDR upsert, İYS apply) attach
 * in Phases 2/3/5 by reading NetgsmWebhookEvent / subscribing to bus events.
 */
@Controller('public/netgsm')
export class NetgsmEventsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(':workspaceId/:token/events')
  @HttpCode(202)
  async events(
    @Param('workspaceId') workspaceId: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!verifyNetgsmWebhookToken(workspaceId, 'events', token)) throw new NotFoundException();
    const b = (body ?? {}) as Record<string, unknown>;
    const externalId =
      (typeof b.unique_id === 'string' && b.unique_id) ||
      (typeof b.uniqueid === 'string' && b.uniqueid) ||
      payloadDigest(body);
    // Duplicate delivery — first archive row wins. skipDuplicates emits a
    // native ON CONFLICT DO NOTHING, so a concurrent NetGSM retry is a clean
    // no-op instead of a P2002 500 (Prisma EMULATES upsert for this compound
    // key + empty-update shape, which loses the insert race).
    await this.prisma.netgsmWebhookEvent.createMany({
      data: [{ workspaceId, purpose: 'events', externalId, payload: (body ?? {}) as object }],
      skipDuplicates: true,
    });
    return { ok: true };
  }
}
