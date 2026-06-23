import { Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { CustomDomainsService } from './custom-domains.service';
import { SitesService } from '../sites/sites.service';
import { isCustomDomainsEnabled } from './custom-domains.config';

/**
 * Host-header middleware (GHL parity, Epic 13). When an inbound Host matches a
 * VERIFIED custom domain, serve that workspace's public SitePage for the path;
 * otherwise pass through so the platform's own host + API behave normally.
 *
 * INERT by default: the very first line is a pure pass-through unless
 * CUSTOM_DOMAINS_ENABLED is set, so on the live deploy this adds nothing but an
 * env check to the request path. It never touches /api, health, or ACME paths,
 * and any resolve/render error falls through to normal routing.
 */
export function customDomainHostMiddleware(
  domains: CustomDomainsService,
  sites: SitesService,
) {
  const logger = new Logger('CustomDomainHost');
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isCustomDomainsEnabled()) return next(); // INERT — nothing runs until ops enables
    const path = req.path || '';
    // Never hijack the API, health/metrics probes, or ACME HTTP-01 challenges.
    if (
      path.startsWith('/api') ||
      path.startsWith('/.well-known') ||
      path === '/health' ||
      path === '/metrics'
    ) {
      return next();
    }
    const host = (req.hostname || '').toLowerCase();
    if (!host) return next();

    let match: { workspaceId: string; homeSlug: string } | null;
    try {
      match = await domains.resolveHost(host);
    } catch {
      return next(); // resolution failure must never break the request
    }
    if (!match) return next(); // not a custom domain → normal routing

    try {
      const slug = path === '/' || path === '' ? match.homeSlug : path.replace(/^\/+/, '').split('/')[0];
      const html = await sites.renderPublic(match.workspaceId, slug, `https://${host}`);
      if (html == null) {
        res.status(404).type('html').send('<h1>404 — page not found</h1>');
        return;
      }
      res.type('html').send(html);
    } catch (e) {
      logger.warn(`custom-domain render failed for ${host}${path}: ${(e as Error)?.message}`);
      next();
    }
  };
}
