import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { TriggerLinksService } from '../trigger-links/trigger-links.service';

/**
 * Public trigger-link click → 302 redirect. No auth (a link is meant to be
 * shared). Resolution is by the globally-unique slug. The optional `?c=` carries
 * a contact id for attribution. Open-redirect-safe: only the workspace-authored,
 * http(s)-validated targetUrl is ever used; an unknown slug or unsafe target
 * falls back to PUBLIC_BASE_URL. Click recording is best-effort and never blocks
 * the redirect.
 */
@Controller('public/l')
export class PublicTriggerLinkController {
  constructor(
    private readonly links: TriggerLinksService,
    private readonly config: ConfigService,
  ) {}

  @Get(':slug')
  async click(
    @Param('slug') slug: string,
    @Query('c') contactId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const target = await this.links
      .click(slug, { contactId, ip, userAgent: req.headers['user-agent'] })
      .catch(() => null);
    res.redirect(302, target ?? this.config.get<string>('PUBLIC_BASE_URL') ?? '/');
  }
}
