import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Static token guard for the nightly-routine endpoints (/api/internal/reviews/*
 * and the later content/insights/lead-scoring routines). A SEPARATE secret from
 * RESEARCH_ROUTINE_TOKEN and INTERNAL_SERVICE_TOKEN: each cloud routine is its
 * own principal, its credential lives in the routine config, and a leak of one
 * must not grant another surface. Fails closed when ROUTINE_TOKEN is unset.
 */
@Injectable()
export class RoutineTokenGuard implements CanActivate {
  private readonly logger = new Logger(RoutineTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('ROUTINE_TOKEN');
    if (!expected) {
      this.logger.error(
        'ROUTINE_TOKEN not configured — rejecting routine call',
      );
      throw new UnauthorizedException('Routine API disabled');
    }

    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-routine-token'];
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing routine token');
    }

    const headerBuf = Buffer.from(header, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (headerBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Invalid routine token');
    }
    if (!timingSafeEqual(headerBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid routine token');
    }

    return true;
  }
}
