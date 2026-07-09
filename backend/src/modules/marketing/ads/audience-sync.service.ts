import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { SegmentCompilerService, SegmentNode } from '../services/segment-compiler.service';
import { AdWriteCapabilityService } from './ad-write-capability.service';
import { sha256, toE164Digits } from './meta-capi.client';
import {
  createCustomAudience,
  addAudienceUsers,
  createLookalikeAudience,
} from './meta-ads-management.client';
import {
  uploadTiktokAudienceFile,
  createTiktokCustomAudience,
  appendTiktokAudienceUsers,
} from './tiktok-audience.client';
import { createLinkedinDmpSegment, addLinkedinDmpUsers } from './linkedin-audience.client';

/** Meta caps a customer-list upload batch at 10k users. */
const BATCH = 10_000;

export interface SyncSegmentOptions {
  /** Include hashed phone numbers (Meta only; default true). */
  includePhone?: boolean;
  /** Also seed a Lookalike from the populated custom audience (Meta only). */
  createLookalike?: boolean;
  /** Lookalike source country (ISO-2, default 'TR'). */
  country?: string;
  /** Lookalike ratio 0.01–0.20 (default 0.01 = 1%). */
  ratio?: number;
}

export interface SyncSegmentResult {
  audienceId: string;
  uploaded: number;
  received: number;
  invalid: number;
  lookalikeId: string | null;
  status: string;
}

type LeadScope = { mergedIntoId: null; deletedAt: null; AND: unknown[] };

/**
 * CRM segment → ad-platform Custom Audience sync, dispatched by provider:
 *  - META: hashed email+phone, session upload into a Custom Audience, optional Lookalike.
 *  - TIKTOK: EMAIL_SHA256 file upload into a DMP custom audience.
 *  - LINKEDIN: email-only SHA-256 into a DMP segment.
 *
 * Compiles the segment to a Lead query, hashes each CONSENTING member (opted-out
 * / invalid-email leads excluded), and reuses a per-(segment, account) audience
 * so a re-sync appends instead of duplicating. Gated on canSyncAudience(provider)
 * so each provider ships dark without its creds.
 */
@Injectable()
export class AudienceSyncService {
  private readonly logger = new Logger(AudienceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly compiler: SegmentCompilerService,
    private readonly capabilities: AdWriteCapabilityService,
  ) {}

  async syncSegment(
    workspaceId: string,
    segmentId: string,
    accountId: string,
    opts: SyncSegmentOptions = {},
  ): Promise<SyncSegmentResult> {
    const account = await this.prisma.adAccount.findFirst({ where: { id: accountId, workspaceId } });
    if (!account) throw new NotFoundException('Ad account not found');
    if (!this.capabilities.canSyncAudience(account.provider)) {
      throw new BadRequestException(`${account.provider} audience sync is not available on this platform`);
    }
    let token: string;
    try {
      token = openSecret(account.accessToken);
    } catch {
      throw new BadRequestException('Access token could not be decrypted');
    }

    const segment = await this.prisma.segment.findFirst({ where: { id: segmentId, workspaceId } });
    if (!segment) throw new NotFoundException('Segment not found');
    const filter = this.compiler.compile(workspaceId, segment.definition as unknown as SegmentNode);
    // Inline workspaceId in every Lead query below (not hoisted) so the
    // multi-tenant arch-fitness scanner can see the scope literal.
    const scope: LeadScope = { mergedIntoId: null, deletedAt: null, AND: [filter] };

    const existing = await this.prisma.segmentAudienceSync.findUnique({
      where: { segmentId_adAccountId: { segmentId, adAccountId: accountId } },
    });

    const ctx = { workspaceId, segmentId, accountId, account, token, segment, scope, opts, existing };
    switch (account.provider) {
      case 'META':
        return this.syncMeta(ctx);
      case 'TIKTOK':
        return this.syncTiktok(ctx);
      case 'LINKEDIN':
        return this.syncLinkedin(ctx);
      default:
        throw new BadRequestException(`${account.provider} audience sync is not supported`);
    }
  }

  /** Read the current sync state for a segment+account (or null). */
  status(workspaceId: string, segmentId: string, accountId: string) {
    return this.prisma.segmentAudienceSync.findFirst({
      where: { workspaceId, segmentId, adAccountId: accountId },
    });
  }

  // ── META ────────────────────────────────────────────────────────────────
  private async syncMeta(c: SyncCtx): Promise<SyncSegmentResult> {
    const { workspaceId, segmentId, accountId, account, token, segment, scope, opts, existing } = c;
    const includePhone = opts.includePhone !== false;
    const schema = includePhone ? ['EMAIL', 'PHONE'] : ['EMAIL'];

    let audienceId = existing?.externalAudienceId ?? null;
    if (!audienceId) {
      const created = await createCustomAudience(token, account.externalAdId, { name: `CRM: ${segment.name}`.slice(0, 100) });
      if (!created.ok || !created.id) {
        await this.recordError(workspaceId, segmentId, accountId, 'META', created.error ?? 'create audience failed');
        this.onAuthError(account.id, created.isAuthError);
        throw new BadRequestException(created.error ?? 'Failed to create the Meta audience');
      }
      audienceId = created.id;
    }

    const total = await this.prisma.lead.count({ where: { workspaceId, ...scope } });
    const sessionId = randomInt(1, 2_147_483_646);
    let uploaded = 0;
    let received = 0;
    let invalid = 0;
    let batchSeq = 1;

    for (let skip = 0; ; skip += BATCH) {
      const leads = await this.prisma.lead.findMany({
        where: { workspaceId, ...scope },
        select: { emailNormalized: true, phoneNormalized: true, emailOptOut: true, smsOptOut: true, emailVerifiedStatus: true },
        orderBy: { createdAt: 'asc' },
        skip,
        take: BATCH,
      });
      if (leads.length === 0) break;

      const rows: string[][] = [];
      for (const l of leads) {
        const em = this.emailHash(l);
        const ph = includePhone && !l.smsOptOut ? sha256(toE164Digits(l.phoneNormalized)) : undefined;
        if (!em && !ph) continue;
        rows.push(includePhone ? [em ?? '', ph ?? ''] : [em ?? '']);
      }

      const isLast = leads.length < BATCH;
      if (rows.length > 0) {
        const res = await addAudienceUsers(token, audienceId, schema, rows, {
          session_id: sessionId,
          batch_seq: batchSeq,
          last_batch_flag: isLast,
          estimated_num_total: total,
        });
        if (!res.ok) {
          await this.recordError(workspaceId, segmentId, accountId, 'META', res.error ?? 'upload failed');
          this.onAuthError(account.id, res.isAuthError);
          throw new BadRequestException(res.error ?? 'Failed to upload audience users');
        }
        uploaded += rows.length;
        received += res.numReceived ?? 0;
        invalid += res.numInvalid ?? 0;
        batchSeq += 1;
      }
      if (isLast) break;
    }

    // Lookalike is sequenced AFTER the seed uploads; best-effort (fails until Meta
    // has matched enough users, so a failure is recorded, not thrown).
    let lookalikeId: string | null = existing?.lookalikeAudienceId ?? null;
    if (opts.createLookalike && audienceId) {
      const lk = await createLookalikeAudience(token, account.externalAdId, {
        name: `LAL: ${segment.name}`.slice(0, 100),
        seedAudienceId: audienceId,
        country: (opts.country ?? 'TR').toUpperCase(),
        ratio: opts.ratio ?? 0.01,
      });
      if (lk.ok && lk.id) lookalikeId = lk.id;
      else this.logger.warn(`Lookalike seed for segment ${segmentId} not ready yet: ${lk.error}`);
    }

    await this.persist(workspaceId, segmentId, accountId, 'META', audienceId, lookalikeId, uploaded);
    return { audienceId, uploaded, received, invalid, lookalikeId, status: 'SYNCED' };
  }

  // ── TIKTOK ──────────────────────────────────────────────────────────────
  private async syncTiktok(c: SyncCtx): Promise<SyncSegmentResult> {
    const { workspaceId, segmentId, accountId, account, token, segment, scope, existing } = c;
    const emails = await this.collectEmailHashes(workspaceId, scope);
    if (emails.length === 0) throw new BadRequestException('No consenting emails to sync');

    const up = await uploadTiktokAudienceFile(token, account.externalAdId, 'EMAIL_SHA256', emails);
    if (!up.ok || !up.filePath) {
      await this.recordError(workspaceId, segmentId, accountId, 'TIKTOK', up.error ?? 'file upload failed');
      this.onAuthError(account.id, up.isAuthError);
      throw new BadRequestException(up.error ?? 'Failed to upload the TikTok audience file');
    }

    let audienceId = existing?.externalAudienceId ?? null;
    const write = audienceId
      ? await appendTiktokAudienceUsers(token, account.externalAdId, { customAudienceId: audienceId, filePaths: [up.filePath], calculateType: 'EMAIL_SHA256' })
      : await createTiktokCustomAudience(token, account.externalAdId, { name: `CRM: ${segment.name}`.slice(0, 100), filePaths: [up.filePath], calculateType: 'EMAIL_SHA256' });
    if (!write.ok) {
      await this.recordError(workspaceId, segmentId, accountId, 'TIKTOK', write.error ?? 'audience write failed');
      this.onAuthError(account.id, write.isAuthError);
      throw new BadRequestException(write.error ?? 'Failed to write the TikTok audience');
    }
    audienceId = write.id ?? audienceId;

    await this.persist(workspaceId, segmentId, accountId, 'TIKTOK', audienceId, null, emails.length);
    return { audienceId: audienceId ?? '', uploaded: emails.length, received: 0, invalid: 0, lookalikeId: null, status: 'SYNCED' };
  }

  // ── LINKEDIN ──────────────────────────────────────────────────────────────
  private async syncLinkedin(c: SyncCtx): Promise<SyncSegmentResult> {
    const { workspaceId, segmentId, accountId, account, token, segment, scope, existing } = c;
    const emails = await this.collectEmailHashes(workspaceId, scope); // LinkedIn is email-only
    if (emails.length === 0) throw new BadRequestException('No consenting emails to sync');

    let audienceId = existing?.externalAudienceId ?? null;
    if (!audienceId) {
      const seg = await createLinkedinDmpSegment(token, account.externalAdId, { name: `CRM: ${segment.name}`.slice(0, 100) });
      if (!seg.ok || !seg.id) {
        await this.recordError(workspaceId, segmentId, accountId, 'LINKEDIN', seg.error ?? 'segment create failed');
        this.onAuthError(account.id, seg.isAuthError);
        throw new BadRequestException(seg.error ?? 'Failed to create the LinkedIn DMP segment');
      }
      audienceId = seg.id;
    }

    const add = await addLinkedinDmpUsers(token, audienceId, emails);
    if (!add.ok) {
      await this.recordError(workspaceId, segmentId, accountId, 'LINKEDIN', add.error ?? 'user add failed');
      this.onAuthError(account.id, add.isAuthError);
      throw new BadRequestException(add.error ?? 'Failed to add LinkedIn DMP users');
    }

    await this.persist(workspaceId, segmentId, accountId, 'LINKEDIN', audienceId, null, add.numAccepted ?? emails.length);
    return { audienceId, uploaded: add.numAccepted ?? emails.length, received: 0, invalid: 0, lookalikeId: null, status: 'SYNCED' };
  }

  // ── Shared ─────────────────────────────────────────────────────────────────
  /** SHA-256 of a lead's normalized email, unless opted-out / known-invalid. */
  private emailHash(l: { emailNormalized: string | null; emailOptOut: boolean; emailVerifiedStatus: string }): string | undefined {
    if (l.emailOptOut || l.emailVerifiedStatus === 'INVALID') return undefined;
    return sha256(l.emailNormalized);
  }

  /** Paginate the segment's consenting members and return their email SHA-256 hashes. */
  private async collectEmailHashes(workspaceId: string, scope: LeadScope): Promise<string[]> {
    const out: string[] = [];
    for (let skip = 0; ; skip += BATCH) {
      const leads = await this.prisma.lead.findMany({
        where: { workspaceId, ...scope },
        select: { emailNormalized: true, emailOptOut: true, emailVerifiedStatus: true },
        orderBy: { createdAt: 'asc' },
        skip,
        take: BATCH,
      });
      if (leads.length === 0) break;
      for (const l of leads) {
        const em = this.emailHash(l);
        if (em) out.push(em);
      }
      if (leads.length < BATCH) break;
    }
    return out;
  }

  private async persist(
    workspaceId: string,
    segmentId: string,
    adAccountId: string,
    provider: string,
    audienceId: string | null,
    lookalikeId: string | null,
    uploaded: number,
  ): Promise<void> {
    const base = {
      externalAudienceId: audienceId,
      lookalikeAudienceId: lookalikeId,
      status: 'SYNCED',
      lastCount: uploaded,
      lastSyncedAt: new Date(),
      lastError: null,
    };
    await this.prisma.segmentAudienceSync.upsert({
      where: { segmentId_adAccountId: { segmentId, adAccountId } },
      create: { workspaceId, segmentId, adAccountId, provider, ...base },
      update: base,
    });
  }

  private async recordError(workspaceId: string, segmentId: string, adAccountId: string, provider: string, error: string) {
    await this.prisma.segmentAudienceSync
      .upsert({
        where: { segmentId_adAccountId: { segmentId, adAccountId } },
        create: { workspaceId, segmentId, adAccountId, provider, status: 'ERROR', lastError: error.slice(0, 500) },
        update: { status: 'ERROR', lastError: error.slice(0, 500) },
      })
      .catch(() => undefined);
  }

  private onAuthError(accountId: string, isAuthError?: boolean): void {
    if (!isAuthError) return;
    void this.prisma.adAccount
      .update({ where: { id: accountId }, data: { status: 'TOKEN_EXPIRED', lastError: 'reauth_required' } })
      .catch(() => undefined);
  }
}

interface SyncCtx {
  workspaceId: string;
  segmentId: string;
  accountId: string;
  account: { id: string; provider: string; externalAdId: string; accessToken: string };
  token: string;
  segment: { name: string };
  scope: LeadScope;
  opts: SyncSegmentOptions;
  existing: { externalAudienceId: string | null; lookalikeAudienceId: string | null } | null;
}
