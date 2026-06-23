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
  SENDING_DOMAIN_VERIFY_KIND,
  SENDING_DOMAIN_POLL_INTERVAL_MS,
  SENDING_DOMAIN_MAX_POLLS,
} from './sending-domains.config';
import {
  DnsCheck,
  allVerified,
  buildRecords,
  dkimHost,
  dkimMatches,
  dmarcHost,
  dmarcMatches,
  missingSummary,
  normalizeDomain,
  spfMatches,
} from './sending-domain.dns';

const generateKeyPairAsync = promisify(generateKeyPair);

/**
 * Sending domains / DKIM (GHL parity, Epic 13 — inert until SENDING_DOMAIN_ESP).
 *
 * request() mints an RSA DKIM keypair (private sealed, public published), hands
 * the tenant the DKIM/SPF/DMARC records to add, and a 'sending-domain.verify'
 * ScheduledJob re-polls DNS until the records appear. resolveFrom() lets the
 * campaign sender route mail From a VERIFIED domain — but only once an ESP
 * transport is configured, so the live email path is untouched by default.
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
    if (!isSendingDomainsConfigured()) {
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

    const created = await this.prisma.sendingDomain.create({
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

  /** Manual "Verify" button — check DNS right now and update the status. */
  async verifyNow(workspaceId: string, id: string) {
    const dom = await this.prisma.sendingDomain.findFirst({ where: { id, workspaceId } });
    if (!dom) throw new NotFoundException('Sending domain not found');
    if (dom.status === 'VERIFIED') return this.present(dom);
    const check = await this.checkDns(dom);
    const data = allVerified(check)
      ? { status: 'VERIFIED', verifiedAt: new Date(), lastError: null }
      : { lastError: missingSummary(check) };
    await this.prisma.sendingDomain.updateMany({ where: { id, workspaceId }, data });
    return this.present({ ...dom, ...data });
  }

  // ---- campaign integration (inert without an ESP transport) ----

  /**
   * The per-workspace From for outbound marketing email. Returns null (→ the
   * platform default) unless an ESP transport is configured AND the workspace
   * has a VERIFIED domain, so by default this changes nothing.
   */
  async resolveFrom(workspaceId: string): Promise<EmailFrom | null> {
    if (!isSendingDomainsConfigured()) return null;
    const dom = await this.prisma.sendingDomain.findFirst({
      where: { workspaceId, status: 'VERIFIED' },
      orderBy: { verifiedAt: 'desc' },
      select: { domain: true, fromEmail: true, fromName: true, dkimSelector: true, dkimPrivateSealed: true },
    });
    if (!dom?.fromEmail) return null;
    const from: EmailFrom = { email: dom.fromEmail, name: dom.fromName ?? undefined };
    // Attach DKIM signing so the From-swap is authenticated (d= aligned to the
    // From domain), not a deliverability-hurting unsigned spoof.
    if (isSecretBoxConfigured() && dom.dkimPrivateSealed) {
      try {
        from.dkim = { domainName: dom.domain, keySelector: dom.dkimSelector, privateKey: openSecret(dom.dkimPrivateSealed) };
      } catch {
        /* unreadable key — send unsigned rather than crash the campaign */
      }
    }
    return from;
  }

  // ---- verify job ----

  private async runVerifyJob(job: ClaimedJob): Promise<JobHandlerResult> {
    const domainId = String(job.payload?.domainId ?? '');
    if (!domainId) return;
    const polls = Number(job.payload?.polls ?? 0) + 1;
    const dom = await this.prisma.sendingDomain.findFirst({
      where: { id: domainId, workspaceId: job.workspaceId },
    });
    if (!dom || dom.status === 'VERIFIED' || dom.status === 'FAILED') return; // settled / gone

    const check = await this.checkDns(dom);
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
    const [dkim, spf, dmarc] = await Promise.all([
      this.resolveTxtSafe(dkimHost(dom.dkimSelector, dom.domain)),
      this.resolveTxtSafe(dom.domain),
      this.resolveTxtSafe(dmarcHost(dom.domain)),
    ]);
    return {
      dkim: dkimMatches(dkim, dom.dkimPublicKey),
      spf: spfMatches(spf, platformSpfInclude()),
      dmarc: dmarcMatches(dmarc),
    };
  }

  private async resolveTxtSafe(host: string): Promise<string[][]> {
    try {
      return await dns.resolveTxt(host);
    } catch {
      return []; // NXDOMAIN / no records yet — treated as "not found"
    }
  }

  /** Strip the sealed DKIM private key and attach the copy-able DNS records. */
  private present<T extends { domain: string; dkimSelector: string; dkimPublicKey: string; dkimPrivateSealed?: string }>(dom: T) {
    const { dkimPrivateSealed: _omit, ...safe } = dom;
    return {
      ...safe,
      records: buildRecords({
        domain: dom.domain,
        selector: dom.dkimSelector,
        publicKeyB64Der: dom.dkimPublicKey,
        spfInclude: platformSpfInclude(),
      }),
    };
  }
}
