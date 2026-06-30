import { Controller, Get, Post, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CampaignTrackingService } from '../campaigns/campaign-tracking.service';

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const PAGE_STYLE =
  'font-family:system-ui;max-width:480px;margin:80px auto;text-align:center';

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

  /**
   * Unsubscribe is a TWO-step (GET confirm → POST act) flow on purpose. A plain
   * GET that flipped the opt-out was unsafe: corporate mail security gateways
   * (Outlook Safe Links, Mimecast, Proofpoint…) and link-prefetching clients
   * fetch EVERY link in an email to scan it — silently unsubscribing real
   * recipients who never clicked. The GET now has no side effect (a scanner just
   * sees the page); the actual opt-out happens on the POST, which also serves
   * RFC 8058 List-Unsubscribe-Post=One-Click native unsubscribe.
   */
  @Get('u/:token')
  async unsubscribe(@Param('token') token: string, @Res() res: Response): Promise<void> {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>` +
        `<div style="${PAGE_STYLE}">` +
        `<h2>Unsubscribe?</h2>` +
        `<p style="color:#64748b">Click below to stop receiving these messages.</p>` +
        `<form method="POST" action="/api/public/u/${esc(token)}">` +
        `<button type="submit" style="background:#1e40af;color:#fff;border:none;padding:12px 28px;border-radius:10px;font-size:1rem;cursor:pointer">Unsubscribe</button>` +
        `</form></div>`,
    );
  }

  @Post('u/:token')
  async unsubscribeSubmit(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const ok = await this.tracking.unsubscribe(token).catch(() => false);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>` +
        `<div style="${PAGE_STYLE}">` +
        `<h2>${ok ? 'You have been unsubscribed' : 'Link expired'}</h2>` +
        `<p style="color:#64748b">${ok ? 'You will no longer receive these messages.' : 'This unsubscribe link is no longer valid.'}</p></div>`,
    );
  }
}
