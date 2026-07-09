import { Controller, Get, Param, NotFoundException, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { R2StorageService } from '../../../common/storage/r2-storage.service';
import { verifyRecordingProxyToken } from '../telephony/recording-proxy-token.util';

/**
 * NetGSM Phase 4 Task 3, fix round 1 — HIGH privacy finding. Public
 * (unauthenticated-by-design, like `PublicInvoiceController`/`NetgsmPublicController`
 * — no `@UseGuards`, the global `APP_GUARD` is only the IP throttler) proxy-stream
 * for a SalesCall's R2-stored call recording.
 *
 * Why this exists: `R2StorageService`'s bucket is public-read (Meta/TikTok
 * pull-from-URL media — see its class docstring), so `urlForKey()` returns a
 * fully public, no-auth, no-TTL object URL. Handing THAT straight to the
 * browser as `<audio src>` (the pre-fix behavior) let a KVKK-regulated call
 * recording escape our auth boundary entirely — it survives in browser
 * history, devtools' network tab, and any error-tracker breadcrumb that
 * captures DOM/network state, all without ever touching `MarketingGuard`.
 *
 * The fix: `SalesCallService.getRecordingUrl` now mints a short-lived (~5 min),
 * workspace+call-scoped HMAC token (`recording-proxy-token.util`, same
 * MARKETING_SECRET_KEY-derived-HMAC-in-path idea as `netgsm-webhook.util` for
 * NetGSM's own unsigned callbacks, and the same "browser element can't send
 * an Authorization header" problem `SseTokenGuard` solves for `EventSource`)
 * and returns THIS route instead. We verify the token in constant time, then
 * fetch the object server-side and pipe its bytes straight through — the
 * underlying bucket/key/public-base-URL never appears anywhere the browser
 * can see it.
 *
 * Only the R2-stored copy is proxied. A call whose recording hasn't been
 * ingested yet (Task 2's sweep) has no `recordingStorageKey`, so
 * `getRecordingUrl` falls back to the raw NetGSM `recordingUrl` instead —
 * that's already a provider-tokenized, short-lived link, not our public
 * bucket, so it's an accepted (and simpler) fallback rather than proxying it
 * here too.
 */
@Controller('public/telephony/recording')
export class RecordingProxyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2StorageService,
  ) {}

  @Get(':workspaceId/:callId/:token')
  async stream(
    @Param('workspaceId') workspaceId: string,
    @Param('callId') callId: string,
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    // Constant-time verify FIRST — reject before any DB/R2 work so a forged
    // URL can't probe for a call's existence. Always a plain 404 (never a
    // 401/403 that would confirm the workspaceId+callId combination is real).
    if (!verifyRecordingProxyToken(workspaceId, callId, token)) {
      throw new NotFoundException();
    }

    const call = await this.prisma.salesCall.findFirst({
      where: { id: callId, workspaceId },
      select: { recordingStorageKey: true },
    });
    if (!call?.recordingStorageKey) {
      throw new NotFoundException();
    }

    let obj: Awaited<ReturnType<R2StorageService['getObjectStream']>>;
    try {
      obj = await this.r2.getObjectStream(call.recordingStorageKey);
    } catch {
      // R2 misconfigured, object deleted, transient fetch failure — all look
      // like "no recording" from the caller's point of view.
      throw new NotFoundException();
    }

    res.setHeader('Content-Type', obj.contentType || 'audio/mpeg');
    if (obj.contentLength != null) {
      res.setHeader('Content-Length', String(obj.contentLength));
    }
    // KVKK — call audio is sensitive; never let a shared cache or the
    // browser's disk cache retain it beyond this one response.
    res.setHeader('Cache-Control', 'private, no-store');

    obj.body.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    obj.body.pipe(res);
  }
}
