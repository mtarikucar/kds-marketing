import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ReviewOAuthService } from '../reviews/review-oauth.service';

/**
 * Provider OAuth redirect target for review-source connect (no auth — the
 * provider redirects the browser here; the sealed `state` carries the workspace
 * + source). On success the token is sealed onto the source and the user is sent
 * back to the Reviews panel.
 */
@Controller('public/reviews/oauth')
export class PublicReviewOAuthController {
  constructor(private readonly oauth: ReviewOAuthService) {}

  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string, @Res() res: Response): Promise<void> {
    let ok = false;
    try {
      await this.oauth.handleCallback(state, code);
      ok = true;
    } catch {
      ok = false;
    }
    const base = (process.env.MARKETING_PUBLIC_URL?.trim() || '').replace(/\/+$/, '');
    res.redirect(302, `${base}/reviews?connected=${ok ? '1' : '0'}`);
  }
}
