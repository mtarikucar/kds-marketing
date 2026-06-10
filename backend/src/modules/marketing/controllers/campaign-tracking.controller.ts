import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CampaignTrackingService } from '../campaigns/campaign-tracking.service';

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * Public campaign tracking: open pixel, click redirect (open-redirect-safe —
 * only campaign-authored links resolve), and one-click unsubscribe. No auth —
 * gated by the unguessable per-recipient token.
 */
@Controller('public')
export class CampaignTrackingController {
  constructor(
    private readonly tracking: CampaignTrackingService,
    private readonly config: ConfigService,
  ) {}

  @Get('t/o/:token')
  async open(@Param('token') token: string, @Res() res: Response): Promise<void> {
    await this.tracking.open(token).catch(() => undefined);
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
    res.send(PIXEL);
  }

  @Get('t/c/:token')
  async click(
    @Param('token') token: string,
    @Query('i') i: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.tracking.click(token, Number(i) || 0).catch(() => null);
    res.redirect(302, url ?? this.config.get<string>('PUBLIC_BASE_URL') ?? '/');
  }

  @Get('u/:token')
  async unsubscribe(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const ok = await this.tracking.unsubscribe(token).catch(() => false);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>` +
        `<div style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center">` +
        `<h2>${ok ? 'You have been unsubscribed' : 'Link expired'}</h2>` +
        `<p style="color:#64748b">${ok ? 'You will no longer receive these messages.' : 'This unsubscribe link is no longer valid.'}</p></div>`,
    );
  }
}
