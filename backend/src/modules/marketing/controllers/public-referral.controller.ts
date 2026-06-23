import { Controller, Get, Post, Body, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { IsString, IsNotEmpty, IsEmail, MaxLength } from 'class-validator';
import { AffiliateService } from '../services/affiliate.service';

/** 30 days — how long an affiliate referral click is attributed to a later lead. */
const REF_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const AFF_REF_COOKIE = 'aff_ref';

class SelfSignupDto {
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsEmail() @MaxLength(200) email: string;
}

/** Read a cookie value from the raw header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Public affiliate referral loop (no auth). GET /r/:slug records the click as an
 * attribution cookie and 302s to the platform (same-origin only — no open
 * redirect); the cookie is consumed when the visitor later submits a public form
 * (forms.service attributes the new lead to the affiliate). POST /r/:slug/signup
 * is opt-in self-signup creating a PENDING affiliate for the referrer's workspace.
 */
@Controller('public')
export class PublicReferralController {
  constructor(
    private readonly affiliates: AffiliateService,
    private readonly config: ConfigService,
  ) {}

  @Get('r/:slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async redirect(@Param('slug') slug: string, @Query('to') to: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const aff = await this.affiliates.resolveReferralSlug(slug).catch(() => null);
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/+$/, '');
    // Only a same-origin RELATIVE path is honored (must start with a single "/"
    // followed by a non-slash/backslash) — never an absolute URL → no open redirect.
    const path = typeof to === 'string' && /^\/[^/\\]/.test(to) ? to : '/';
    if (aff && aff.status === 'ACTIVE') {
      res.cookie(AFF_REF_COOKIE, slug, {
        maxAge: REF_COOKIE_MAX_AGE_MS,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
    }
    res.redirect(302, `${base}${path}`);
  }

  @Post('r/:slug/signup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async signup(@Param('slug') slug: string, @Body() dto: SelfSignupDto, @Res() res: Response): Promise<void> {
    const aff = await this.affiliates.resolveReferralSlug(slug).catch(() => null);
    if (!aff) {
      res.status(404).json({ message: 'Unknown referral link' });
      return;
    }
    await this.affiliates.selfSignup(aff.workspaceId, dto);
    // PENDING — staff approves before it can earn. Don't leak the new affiliate id.
    res.status(201).json({ ok: true, status: 'PENDING' });
  }
}
