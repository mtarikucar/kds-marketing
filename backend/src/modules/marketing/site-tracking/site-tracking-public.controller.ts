import { Controller, Get, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { SiteTrackingService } from './site-tracking.service';

/** 1×1 transparent GIF89a. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * GET /api/public/s/:siteKey/pv.gif — the jeeta.js page-view pixel (contract
 * §7.3). An image request, so no CORS and no preflight: the API's CORS
 * allowlist is untouched. Always the same 200 GIF, whatever happened — an
 * unknown key, the flag off, a foreign host or a database error must never
 * show as a broken image on a store page, and must not tell a prober which
 * keys exist. Page views are frequent, hence a per-IP throttle of its own.
 */
@Controller('public/s')
export class SiteTrackingPublicController {
  private readonly logger = new Logger(SiteTrackingPublicController.name);

  constructor(private readonly tracking: SiteTrackingService) {}

  @Get(':siteKey/pv.gif')
  // `default` is the global throttler's name; any other key is silently ignored.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async pageView(
    @Param('siteKey') siteKey: string,
    @Query() q: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.tracking.recordPageView({
        siteKey,
        // Only plain strings: a repeated or bracketed param is dropped, not coerced.
        query: { p: str(q.p), s: str(q.s), m: str(q.m), c: str(q.c), r: str(q.r) },
        referer: str(req.headers.referer),
        userAgent: str(req.headers['user-agent']),
      });
    } catch (e) {
      this.logger.warn(`page view failed: ${(e as Error)?.message ?? e}`);
    }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
    res.status(200).send(PIXEL);
  }
}
