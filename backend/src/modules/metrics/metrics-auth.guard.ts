import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Optional bearer-token gate for the Prometheus scrape endpoint.
 *
 * `/api/metrics` exposes operational/business series (request shapes, outbox DLQ
 * depth, payment-order counts by status) that should NOT be world-readable. When
 * `METRICS_SCRAPE_TOKEN` is set, the scraper must present it (Authorization:
 * Bearer <token>, or an `x-metrics-token` header), compared in constant time.
 *
 * Defense-in-depth: the primary control is still a network restriction at the
 * edge (the public vhost should not proxy /api/metrics). This guard ensures the
 * endpoint isn't wide open even if the proxy is misconfigured. When the env is
 * UNSET the guard allows access in dev/internal contexts — but in PRODUCTION an
 * unset token fails CLOSED (503), so a forgotten env can never silently expose
 * the metrics surface to the world.
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.METRICS_SCRAPE_TOKEN;
    if (!expected) {
      // Fail CLOSED in production: an unset token there is a misconfiguration,
      // not a license to serve the metrics surface unauthenticated. Dev /
      // internal-only stays open so local scrapers keep working.
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('metrics auth not configured');
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers['authorization'];
    const bearer =
      typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice(7)
        : undefined;
    const headerToken = req.headers['x-metrics-token'];
    const presented =
      bearer ?? (typeof headerToken === 'string' ? headerToken : undefined);

    if (!presented || !this.safeEqual(presented, expected)) {
      throw new UnauthorizedException('Invalid metrics token');
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
