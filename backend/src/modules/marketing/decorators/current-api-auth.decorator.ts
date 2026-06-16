import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiAuth } from '../services/api-keys.service';

/** Epic B1 — the API-key auth context attached by ApiKeyGuard. */
export const CurrentApiAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiAuth =>
    ctx.switchToHttp().getRequest().apiAuth,
);
