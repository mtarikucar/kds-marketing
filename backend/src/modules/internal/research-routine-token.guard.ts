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
 * Static token guard for the external nightly-research routine
 * (/api/internal/research/*). Validates x-research-token against
 * RESEARCH_ROUTINE_TOKEN — a separate principal from ROUTINE_TOKEN and
 * INTERNAL_SERVICE_TOKEN so a leak of one credential cannot grant another
 * surface. Fails closed when RESEARCH_ROUTINE_TOKEN is unset.
 */
@Injectable()
export class ResearchRoutineTokenGuard implements CanActivate {
  private readonly logger = new Logger(ResearchRoutineTokenGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('RESEARCH_ROUTINE_TOKEN');
    if (!expected) {
      this.logger.error(
        'RESEARCH_ROUTINE_TOKEN not configured — rejecting research routine call',
      );
      throw new UnauthorizedException('Research routine API disabled');
    }

    const request = context.switchToHttp().getRequest();
    const header = request.headers['x-research-token'];
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing research routine token');
    }

    const headerBuf = Buffer.from(header, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (headerBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Invalid research routine token');
    }
    if (!timingSafeEqual(headerBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid research routine token');
    }

    return true;
  }
}
