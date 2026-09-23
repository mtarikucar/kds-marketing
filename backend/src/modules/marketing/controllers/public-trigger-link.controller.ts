import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { TriggerLinksService } from '../trigger-links/trigger-links.service';
import { TRACKING_GET_THROTTLE } from '../public-throttle.const';
import { getClientIp } from '../../../common/helpers/client-ip.helper';
import { isAutomatedFetch } from '../../../common/util/automated-fetch';

/**
 * Public trigger-link click → 302 redirect. No auth (a link is meant to be
 * shared). Resolution is by the globally-unique slug. The optional `?c=` carries
 * a SIGNED contact claim for attribution (a raw lead id is ignored — see
 * `trigger-link-contact.token.ts`). Open-redirect-safe: only the
 * workspace-authored, http(s)-validated targetUrl is ever used; an unknown slug
 * or unsafe target falls back to PUBLIC_BASE_URL. Click recording is best-effort
 * and never blocks the redirect.
 */
@Controller('public/l')
export class PublicTriggerLinkController {
  constructor(
    private readonly links: TriggerLinksService,
    private readonly config: ConfigService,
  ) {}

  // A public write (click row + counter + workflow event), so it carries a
  // per-route throttle — its own loose tracking bucket, because a 429 on a
  // redirect is a recipient sent nowhere (see the constant).
  @Get(':slug')
  @Throttle(TRACKING_GET_THROTTLE)
  async click(
    @Param('slug') slug: string,
    @Query('c') contactId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // `getClientIp` rather than the left-most X-Forwarded-For hop: that hop is
    // client-supplied and fully spoofable, and this value is persisted as audit
    // attribution and re-exported in the KVKK subject-access export.
    const ip = getClientIp(req);
    // Classify, never block. Express routes HEAD to the GET handler, so a
    // scanner's probe arrives here as `method: 'HEAD'`.
    const automated = isAutomatedFetch(req);
    const target = await this.links
      .click(slug, { contactId, ip, userAgent: req.headers['user-agent'], automated })
      .catch(() => null);
    // ALWAYS redirect. The target is already open-redirect-safe (the service
    // validates the stored URL), and short-circuiting this line for a hit we
    // merely SUSPECT is automated is the one way this change breaks a real
    // recipient.
    res.redirect(302, target ?? this.config.get<string>('PUBLIC_BASE_URL') ?? '/');
  }
}
