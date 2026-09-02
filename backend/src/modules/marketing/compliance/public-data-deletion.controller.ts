import { Controller, Get, HttpCode, NotFoundException, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';
import {
  PlatformDataDeletionService,
  PlatformDeletionAck,
  PublicDeletionStatus,
} from './platform-data-deletion.service';

/**
 * PUBLIC (unauthenticated) data-deletion surface — the two URLs the owner
 * pastes into the Meta App Dashboard, and the one the person who asked for
 * deletion opens:
 *
 *   POST /api/public/compliance/meta/data-deletion    ← Meta's callback
 *   GET  /api/public/compliance/data-deletion/status  ← the status page's data
 *
 * There is no credential on either: Meta cannot present one, and the person
 * following the returned link has no session with us. The callback's ENTIRE
 * trust boundary is the `signed_request` HMAC, verified in the service — which
 * is why the body is read RAW here rather than through a DTO. Meta owns that
 * payload's shape; a `forbidNonWhitelisted` ValidationPipe would 400 the day
 * Meta adds a field, and a 400 on a genuine deletion callback is an App Review
 * failure that would look like a mystery.
 */
@Controller('public/compliance')
export class PublicDataDeletionController {
  constructor(private readonly svc: PlatformDataDeletionService) {}

  // Nest answers POST with 201 by default; Meta's callback contract is a 200
  // carrying { url, confirmation_code }.
  @Post('meta/data-deletion')
  @HttpCode(200)
  @Throttle(PUBLIC_WRITE_THROTTLE)
  metaDeletion(@Req() req: Request): Promise<PlatformDeletionAck> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const signedRequest = typeof body.signed_request === 'string' ? body.signed_request : '';
    return this.svc.handleMetaRequest(signedRequest, publicOrigin(req));
  }

  /**
   * Status of one request by its confirmation code. 404 (not an empty 200) for
   * an unknown code — the page must be able to say "we have no record of this"
   * instead of rendering a blank that implies success.
   */
  @Get('data-deletion/status')
  async status(@Query('code') code: string): Promise<PublicDeletionStatus> {
    const found = await this.svc.statusByCode((code ?? '').trim());
    if (!found) throw new NotFoundException('No deletion request with that confirmation code');
    return found;
  }
}

/**
 * The origin the status link is built on. PUBLIC_BASE_URL is the configured
 * truth; the request's own origin is the fallback so a deploy that forgot the
 * env var still returns a URL that WORKS rather than a relative fragment Meta
 * would reject.
 */
function publicOrigin(req: Request): string {
  const configured = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : '';
}
