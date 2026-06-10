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
 * Static token guard for the research-routine endpoints
 * (/api/internal/research/*). Deliberately a SEPARATE secret from
 * INTERNAL_SERVICE_TOKEN: the nightly research agent is a different
 * principal than the core service — its credential lives in a cloud
 * routine config, rotates on a different schedule, and a leak of one
 * must not grant the other's surface.
 */
@Injectable()
export class ResearchTokenGuard implements CanActivate {
  private readonly logger = new Logger(ResearchTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('RESEARCH_ROUTINE_TOKEN');
    if (!expected) {
      this.logger.error(
        'RESEARCH_ROUTINE_TOKEN not configured — rejecting research call',
      );
      throw new UnauthorizedException('Research API disabled');
    }

    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-research-token'];
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing research token');
    }

    const headerBuf = Buffer.from(header, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (headerBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Invalid research token');
    }
    if (!timingSafeEqual(headerBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid research token');
    }

    return true;
  }
}
