import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService } from '../services/api-keys.service';

/**
 * Epic B1 — authenticates a public REST request by its API key
 * (`Authorization: Bearer mk_live_…` or `X-Api-Key`), resolves the workspace,
 * and enforces a scope by HTTP method (GET/HEAD → read, else write). On success
 * it attaches `req.apiAuth = { workspaceId, scopes, apiKeyId }`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = this.extract(req);
    if (!raw) throw new UnauthorizedException('Missing API key');

    const auth = await this.apiKeys.authenticate(raw);
    if (!auth) throw new UnauthorizedException('Invalid or revoked API key');

    const method = String(req.method ?? 'GET').toUpperCase();
    const needed = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
    if (!auth.scopes.includes(needed)) {
      throw new ForbiddenException(`API key lacks "${needed}" scope`);
    }

    req.apiAuth = {
      workspaceId: auth.workspaceId,
      scopes: auth.scopes,
      apiKeyId: auth.apiKeyId,
    };
    return true;
  }

  private extract(req: {
    headers?: Record<string, unknown>;
  }): string | null {
    const authz = req.headers?.authorization;
    if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
      return authz.slice(7).trim();
    }
    const x = req.headers?.['x-api-key'];
    return typeof x === 'string' ? x : null;
  }
}
