import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CustomDomainsService } from '../custom-domains/custom-domains.service';

/**
 * On-demand TLS authorization for the edge proxy (Caddy `on_demand_tls.ask`).
 * Caddy hits this before issuing a certificate for an inbound host; we return
 * 200 only for a VERIFIED custom domain (so the edge can't be tricked into
 * minting certs for arbitrary hostnames) and flip the domain to ACTIVE/ISSUED.
 * Inert (404 for everything) until CUSTOM_DOMAINS_ENABLED.
 */
@Controller('public/custom-domains')
export class PublicCustomDomainController {
  constructor(private readonly domains: CustomDomainsService) {}

  @Get('tls-ask')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async tlsAsk(@Query('domain') domain: string, @Res() res: Response): Promise<void> {
    const ok = await this.domains.tlsAsk(domain).catch(() => false);
    res.status(ok ? 200 : 404).type('text/plain').send(ok ? 'OK' : 'no');
  }
}
