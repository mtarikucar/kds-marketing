import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import {
  HOST_CACHE_TTL_MS,
  HOST_CACHE_MAX_ENTRIES,
  isCustomDomainsEnabled,
  platformCnameTarget,
} from './custom-domains.config';
import { buildInstructions, normalizeHostname, txtHasToken, verifyTxtHost } from './custom-domain.dns';

interface HostResolution {
  workspaceId: string;
  homeSlug: string;
}

/**
 * Custom-domain white-label (GHL parity, Epic 13 — inert until
 * CUSTOM_DOMAINS_ENABLED). request() mints an ownership token + CNAME/TXT
 * instructions; an advisory-locked @Cron sweep re-polls DNS and flips
 * PENDING→VERIFIED; resolveHost() (cached) backs the Host-header middleware.
 */
@Injectable()
export class CustomDomainsService {
  private readonly logger = new Logger(CustomDomainsService.name);
  /** host → resolution (null = known-not-a-custom-domain), with a TTL. */
  private readonly hostCache = new Map<string, { res: HostResolution | null; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  // ---- CRUD ----

  async request(workspaceId: string, dto: { hostname: string; homeSlug?: string }) {
    if (!isCustomDomainsEnabled()) {
      throw new ServiceUnavailableException('Custom domains are not enabled');
    }
    const hostname = normalizeHostname(dto.hostname);
    if (!hostname) throw new BadRequestException('Enter a valid hostname, e.g. www.acme.com');
    const existing = await this.prisma.customDomain.findUnique({ where: { hostname } });
    if (existing) throw new ConflictException('That hostname is already registered');
    const created = await this.prisma.customDomain.create({
      data: {
        workspaceId,
        hostname,
        verifyToken: randomBytes(16).toString('hex'),
        homeSlug: dto.homeSlug?.trim() || 'home',
        status: 'PENDING',
      },
    });
    return this.present(created);
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.customDomain.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.present(r));
  }

  async get(workspaceId: string, id: string) {
    const dom = await this.prisma.customDomain.findFirst({ where: { id, workspaceId } });
    if (!dom) throw new NotFoundException('Custom domain not found');
    return this.present(dom);
  }

  async remove(workspaceId: string, id: string) {
    const dom = await this.prisma.customDomain.findFirst({ where: { id, workspaceId }, select: { hostname: true } });
    const res = await this.prisma.customDomain.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Custom domain not found');
    if (dom?.hostname) this.hostCache.delete(dom.hostname);
    return { deleted: true };
  }

  /** Manual "Verify" button — check the TXT token now and flip if present. */
  async verifyNow(workspaceId: string, id: string) {
    const dom = await this.prisma.customDomain.findFirst({ where: { id, workspaceId } });
    if (!dom) throw new NotFoundException('Custom domain not found');
    if (dom.status === 'VERIFIED' || dom.status === 'ACTIVE') return this.present(dom);
    const ok = await this.checkTxt(dom.hostname, dom.verifyToken);
    const data = ok
      ? { status: 'VERIFIED', txtVerifiedAt: new Date(), lastError: null, lastCheckedAt: new Date() }
      : { lastError: 'Verification TXT record not found yet — DNS can take a while to propagate.', lastCheckedAt: new Date() };
    await this.prisma.customDomain.updateMany({ where: { id, workspaceId }, data });
    this.hostCache.delete(dom.hostname);
    return this.present({ ...dom, ...data });
  }

  // ---- host resolution (for the middleware) ----

  /** Resolve an inbound Host header to a servable workspace site, cached. */
  async resolveHost(rawHost: string): Promise<HostResolution | null> {
    // Reject anything that isn't a real hostname BEFORE touching the cache or DB,
    // so attacker-sprayed garbage hosts can't become cache keys or DB lookups.
    const host = normalizeHostname(String(rawHost ?? '').replace(/:\d+$/, ''));
    if (!host) return null;
    const now = Date.now();
    const hit = this.hostCache.get(host);
    if (hit && now - hit.at < HOST_CACHE_TTL_MS) return hit.res;
    const dom = await this.prisma.customDomain.findUnique({
      where: { hostname: host },
      select: { workspaceId: true, homeSlug: true, status: true },
    });
    const servable = !!dom && (dom.status === 'VERIFIED' || dom.status === 'ACTIVE');
    const res: HostResolution | null = servable ? { workspaceId: dom!.workspaceId, homeSlug: dom!.homeSlug } : null;
    // Bound the cache (FIFO evict oldest) — Map preserves insertion order.
    if (this.hostCache.size >= HOST_CACHE_MAX_ENTRIES && !this.hostCache.has(host)) {
      const oldest = this.hostCache.keys().next().value;
      if (oldest !== undefined) this.hostCache.delete(oldest);
    }
    this.hostCache.set(host, { res, at: now });
    return res;
  }

  /**
   * On-demand TLS gate for the edge (e.g. Caddy `on_demand_tls.ask`): may a cert
   * be issued for this host? True only for a VERIFIED/ACTIVE custom domain — so
   * the edge can never be tricked into issuing certs for arbitrary hostnames.
   * On the first ask (= the cert is being provisioned) we stamp ISSUED/ACTIVE so
   * the dead `sslStatus`/`status` states finally reflect reality. Inert (false)
   * until CUSTOM_DOMAINS_ENABLED.
   */
  async tlsAsk(rawHost: string): Promise<boolean> {
    if (!isCustomDomainsEnabled()) return false;
    const host = normalizeHostname(String(rawHost ?? '').replace(/:\d+$/, ''));
    if (!host) return false;
    const dom = await this.prisma.customDomain.findUnique({
      where: { hostname: host },
      select: { id: true, workspaceId: true, status: true, sslStatus: true },
    });
    if (!dom || (dom.status !== 'VERIFIED' && dom.status !== 'ACTIVE')) return false;
    if (dom.sslStatus !== 'ISSUED' || dom.status !== 'ACTIVE') {
      await this.prisma.customDomain.updateMany({
        where: { id: dom.id, workspaceId: dom.workspaceId },
        data: { sslStatus: 'ISSUED', status: 'ACTIVE' },
      });
      this.hostCache.delete(host);
    }
    return true;
  }

  // ---- verify sweep ----

  @Cron(CronExpression.EVERY_HOUR, { name: 'custom-domains-verify' })
  async verifySweep(): Promise<void> {
    if (!isCustomDomainsEnabled()) return; // inert — no DNS calls until ops enables
    await withAdvisoryLock(
      this.prisma,
      'custom-domains:verify',
      async () => {
        // Cross-workspace system sweep (like AdsPullService): re-poll every
        // tenant's still-PENDING domain. nulls-first ordering + stamping
        // lastCheckedAt on EVERY processed row rotates the window so domains
        // past the first 200 can't be starved. Each write is workspace-scoped.
        const pending = await this.prisma.customDomain.findMany({
          where: { status: 'PENDING' },
          orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
          take: 200,
        });
        for (const dom of pending) {
          try {
            const ok = await this.checkTxt(dom.hostname, dom.verifyToken);
            await this.prisma.customDomain.updateMany({
              where: { id: dom.id, workspaceId: dom.workspaceId },
              data: ok
                ? { status: 'VERIFIED', txtVerifiedAt: new Date(), lastError: null, lastCheckedAt: new Date() }
                : { lastCheckedAt: new Date() },
            });
            if (ok) this.hostCache.delete(dom.hostname);
          } catch (e) {
            this.logger.warn(`custom-domain verify failed for ${dom.hostname}: ${(e as Error)?.message}`);
            await this.prisma.customDomain
              .updateMany({ where: { id: dom.id, workspaceId: dom.workspaceId }, data: { lastCheckedAt: new Date() } })
              .catch(() => undefined);
          }
        }
      },
      this.logger,
    );
  }

  private async checkTxt(hostname: string, verifyToken: string): Promise<boolean> {
    try {
      const txt = await dns.resolveTxt(verifyTxtHost(hostname));
      return txtHasToken(txt, verifyToken);
    } catch {
      return false; // NXDOMAIN / not published yet
    }
  }

  private present<T extends { hostname: string; verifyToken: string }>(dom: T) {
    return { ...dom, instructions: buildInstructions(dom.hostname, dom.verifyToken, platformCnameTarget()) };
  }
}
