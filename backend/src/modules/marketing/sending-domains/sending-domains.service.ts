import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { generateKeyPair, randomBytes } from 'crypto';
import { promisify } from 'util';
import { promises as dns } from 'dns';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService,
  ClaimedJob,
  JobHandlerResult,
} from '../scheduling/scheduled-job-runner.service';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { EmailFrom } from '../../../common/services/email.service';
import {
  isSendingDomainsConfigured,
  platformSpfInclude,
  sendingDomainEspStatus,
  SENDING_DOMAIN_VERIFY_KIND,
  SENDING_DOMAIN_POLL_INTERVAL_MS,
  SENDING_DOMAIN_RETRY_INTERVAL_MS,
  SENDING_DOMAIN_MAX_POLLS,
} from './sending-domains.config';
import {
  DnsCheck,
  allVerified,
  buildRecords,
  checkDkim,
  checkDmarc,
  checkSpf,
  dkimHost,
  dmarcHost,
  isDecisive,
  missingSummary,
  normalizeDomain,
} from './sending-domain.dns';

const generateKeyPairAsync = promisify(generateKeyPair);

/** Resolver codes that mean "nothing is published there", as opposed to
 *  "the question was not answered". Everything else is a blip. */
const DEFINITIVE_DNS_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

interface TxtLookup {
  records: string[][];
  /** The resolver did not answer — says nothing about what is published. */
  unavailable: boolean;
}

/**
 * Sending domains / DKIM (GHL parity, Epic 13 — inert until an ESP is actually
 * configured; see sending-domains.config.ts for what "configured" means).
 *
 * request() mints an RSA DKIM keypair (private sealed, public published), hands
 * the tenant the DKIM/SPF/DMARC records to add, and a 'sending-domain.verify'
 * ScheduledJob re-polls DNS until the records appear. resolveFrom() lets the
 * campaign sender route mail From a VERIFIED domain — but only once the path is
 * armed AND the mail can be DKIM-signed as that domain, so the live email path
 * is untouched by default.
 */
@Injectable()
export class SendingDomainsService implements OnModuleInit {
  private readonly logger = new Logger(SendingDomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJob: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(SENDING_DOMAIN_VERIFY_KIND, (job) => this.runVerifyJob(job));
  }

  // ---- CRUD ----

  async request(workspaceId: string, dto: { domain: string; fromName?: string }) {
    const esp = sendingDomainEspStatus();
    if (!esp.armed) {
      // The tenant gets the plain fact; the missing KEYS are operator detail and
      // belong in the log and the ops health panel, not in a 503 body.
      this.logger.warn(`sending-domain request refused: ESP path not armed (missing: ${esp.missing.join(', ')})`);
      throw new ServiceUnavailableException('Custom sending domains are not enabled');
    }
    if (!isSecretBoxConfigured()) {
      throw new ServiceUnavailableException('MARKETING_SECRET_KEY not configured');
    }
    const domain = normalizeDomain(dto.domain);
    if (!domain) throw new BadRequestException('Enter a valid domain, e.g. mail.acme.com');
    const existing = await this.prisma.sendingDomain.findFirst({ where: { workspaceId, domain } });
    if (existing) throw new ConflictException('That domain is already registered');

    const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const dkimPublicKey = (publicKey as Buffer).toString('base64');
    const dkimSelector = `mkt${randomBytes(3).toString('hex')}`;

    let created;
    try {
      created = await this.prisma.sendingDomain.create({
        data: {
          workspaceId,
          domain,
          status: 'PENDING',
          fromEmail: `noreply@${domain}`,
          fromName: dto.fromName?.trim() || null,
          dkimSelector,
          dkimPublicKey,
          dkimPrivateSealed: sealSecret(privateKey as string),
        },
      });
    } catch (e) {
      // The existing-domain pre-check above is racy; the (workspaceId, domain)
      // unique is the real guard. Map a concurrent same-domain insert to a clean
      // 409, not a raw 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('That domain is already registered');
      }
      throw e;
    }
    await this.scheduledJob.schedule({
      workspaceId,
      kind: SENDING_DOMAIN_VERIFY_KIND,
      runAt: new Date(Date.now() + 60_000), // give the tenant a minute to add records
      payload: { domainId: created.id, polls: 0 },
      dedupKey: `sending-domain:${created.id}`,
      maxAttempts: 5,
    });
    return this.present(created);
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.sendingDomain.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.present(r));
  }

  async get(workspaceId: string, id: string) {
    const dom = await this.prisma.sendingDomain.findFirst({ where: { id, workspaceId } });
    if (!dom) throw new NotFoundException('Sending domain not found');
    return this.present(dom);
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.sendingDomain.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Sending domain not found');
    await this.scheduledJob.cancel(SENDING_DOMAIN_VERIFY_KIND, `sending-domain:${id}`).catch(() => undefined);
    return { deleted: true };
  }

  /**
   * Manual "Verify" button — check DNS right now and update the status.
   *
   * A VERIFIED domain is re-checked too (records do get deleted), but only a
   * DECISIVE check may move anything: a SERVFAIL that demoted a healthy domain
   * would silently revert a campaign mid-flight to the platform From, which is
   * worse than the drift it was meant to catch.
   */
  async verifyNow(workspaceId: string, id: string) {
    const dom = await this.prisma.sendingDomain.findFirst({ where: { id, workspaceId } });
    if (!dom) throw new NotFoundException('Sending domain not found');
    const check = await this.checkDns(dom);
    if (!isDecisive(check)) return this.present(dom, check);

    const verified = allVerified(check);
    const data: { status?: string; verifiedAt?: Date; lastError?: string | null } = verified
      ? { status: 'VERIFIED', verifiedAt: new Date(), lastError: null }
      : { lastError: missingSummary(check) };
    // Records that were really there and are gone: say so instead of going on
    // signing mail with a key the world can no longer look up.
    if (!verified && dom.status === 'VERIFIED') data.status = 'PENDING';
    if (verified && dom.status === 'VERIFIED') return this.present(dom, check); // nothing to write

    await this.prisma.sendingDomain.updateMany({ where: { id, workspaceId }, data });
    return this.present({ ...dom, ...data }, check);
  }

  // ---- campaign integration (inert without an armed ESP path) ----

  /**
   * The per-workspace From for outbound marketing email. Returns null (→ the
   * platform default) unless the ESP path is armed AND the workspace has a
   * VERIFIED domain we can still sign as, so by default this changes nothing.
   */
  async resolveFrom(workspaceId: string): Promise<EmailFrom | null> {
    if (!isSendingDomainsConfigured()) return null;
    const dom = await this.prisma.sendingDomain.findFirst({
      where: { workspaceId, status: 'VERIFIED' },
      orderBy: { verifiedAt: 'desc' },
      select: { domain: true, fromEmail: true, fromName: true, dkimSelector: true, dkimPrivateSealed: true },
    });
    if (!dom?.fromEmail) return null;
    // The envelope stays the platform's, so SPF can never align with a tenant
    // From. DKIM is the ONLY thing that makes the swap pass DMARC — without it
    // the mail is a spoof of the tenant's own domain and is treated as one, so
    // fall back to the platform identity rather than send it unsigned.
    if (!isSecretBoxConfigured() || !dom.dkimPrivateSealed) return null;
    let privateKey: string;
    try {
      privateKey = openSecret(dom.dkimPrivateSealed);
    } catch {
      this.logger.warn(`sending domain ${dom.domain}: DKIM key unreadable — falling back to the platform identity`);
      return null;
    }
    return {
      email: dom.fromEmail,
      name: dom.fromName ?? undefined,
      dkim: { domainName: dom.domain, keySelector: dom.dkimSelector, privateKey },
    };
  }

  // ---- verify job ----

  private async runVerifyJob(job: ClaimedJob): Promise<JobHandlerResult> {
    const domainId = String(job.payload?.domainId ?? '');
    if (!domainId) return;
    const previousPolls = Number(job.payload?.polls ?? 0);
    const dom = await this.prisma.sendingDomain.findFirst({
      where: { id: domainId, workspaceId: job.workspaceId },
    });
    if (!dom || dom.status === 'VERIFIED' || dom.status === 'FAILED') return; // settled / gone

    const check = await this.checkDns(dom);
    // A resolver outage is not a poll: it must neither spend the tenant's
    // ~14-day budget nor leave a "records not found" hint nobody established.
    if (!isDecisive(check)) {
      return { reschedule: { runAt: new Date(Date.now() + SENDING_DOMAIN_RETRY_INTERVAL_MS), payload: { domainId, polls: previousPolls } } };
    }

    const polls = previousPolls + 1;
    if (allVerified(check)) {
      await this.prisma.sendingDomain.updateMany({
        where: { id: domainId, workspaceId: job.workspaceId },
        data: { status: 'VERIFIED', verifiedAt: new Date(), lastError: null },
      });
      return; // DONE
    }
    // Record the hint, then either keep polling or give up after the cap.
    if (polls >= SENDING_DOMAIN_MAX_POLLS) {
      await this.prisma.sendingDomain.updateMany({
        where: { id: domainId, workspaceId: job.workspaceId, status: 'PENDING' },
        data: { status: 'FAILED', lastError: `Records not found after ${polls} checks. ${missingSummary(check)}` },
      });
      return; // DONE — gave up
    }
    await this.prisma.sendingDomain.updateMany({
      where: { id: domainId, workspaceId: job.workspaceId, status: 'PENDING' },
      data: { lastError: missingSummary(check) },
    });
    // Reschedule THIS row in place (one row per domain, no pile-up).
    return { reschedule: { runAt: new Date(Date.now() + SENDING_DOMAIN_POLL_INTERVAL_MS), payload: { domainId, polls } } };
  }

  private async checkDns(dom: { domain: string; dkimSelector: string; dkimPublicKey: string }): Promise<DnsCheck> {
    const include = platformSpfInclude();
    const [dkim, spf, dmarc] = await Promise.all([
      this.resolveTxtSafe(dkimHost(dom.dkimSelector, dom.domain)),
      this.resolveTxtSafe(dom.domain),
      this.resolveTxtSafe(dmarcHost(dom.domain)),
    ]);
    return {
      dkim: dkim.unavailable ? { ok: false, reason: 'UNAVAILABLE' } : checkDkim(dkim.records, dom.dkimPublicKey),
      spf: spf.unavailable ? { ok: false, reason: 'UNAVAILABLE' } : checkSpf(spf.records, include),
      dmarc: dmarc.unavailable ? { ok: false, reason: 'UNAVAILABLE' } : checkDmarc(dmarc.records),
    };
  }

  /**
   * NXDOMAIN/ENODATA is an answer ("nothing is published there"); SERVFAIL, a
   * timeout or a refusal is not. Collapsing both into `[]` is what made a
   * resolver blip indistinguishable from a deleted record.
   */
  private async resolveTxtSafe(host: string): Promise<TxtLookup> {
    try {
      return { records: await dns.resolveTxt(host), unavailable: false };
    } catch (e) {
      const code = String((e as { code?: string })?.code ?? '').toUpperCase();
      if (DEFINITIVE_DNS_CODES.has(code)) return { records: [], unavailable: false };
      this.logger.debug(`TXT lookup for ${host} did not answer (${code || 'unknown'})`);
      return { records: [], unavailable: true };
    }
  }

  /** Strip the sealed DKIM private key and attach the copy-able DNS records.
   *  `check` is transient (never persisted) so the UI can name what is wrong. */
  private present<T extends { domain: string; dkimSelector: string; dkimPublicKey: string; dkimPrivateSealed?: string }>(
    dom: T,
    check?: DnsCheck,
  ) {
    const { dkimPrivateSealed: _omit, ...safe } = dom;
    return {
      ...safe,
      records: buildRecords({
        domain: dom.domain,
        selector: dom.dkimSelector,
        publicKeyB64Der: dom.dkimPublicKey,
        spfInclude: platformSpfInclude(),
      }),
      checks: check,
    };
  }
}
