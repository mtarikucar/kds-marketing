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

/** Meta caps a customer-list upload batch at 10k users. */
const BATCH = 10_000;

export interface SyncSegmentOptions {
  /** Include hashed phone numbers (default true). */
  includePhone?: boolean;
  /** Also seed a Lookalike from the populated custom audience. */
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

/**
 * CRM segment → Meta Custom Audience sync. Compiles the segment to a Lead query,
 * hashes each consenting member's email/phone (SHA-256 of the normalized value),
 * and drives Meta's session upload into a per-(segment, account) audience so a
 * re-sync APPENDS to the same audience instead of duplicating. Optionally seeds a
 * Lookalike once the source is populated.
 *
 * Meta-only + gated on AdWriteCapabilityService.canSyncAudience so it is inert
 * without Meta creds. Consent-aware: opted-out / invalid-email leads are excluded.
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
    if (!this.capabilities.canSyncAudience('META')) {
      throw new BadRequestException('Meta audience sync is not available on this platform');
    }
    const account = await this.prisma.adAccount.findFirst({ where: { id: accountId, workspaceId } });
    if (!account) throw new NotFoundException('Ad account not found');
    if (account.provider !== 'META') {
      throw new BadRequestException('Audience sync is only supported for Meta accounts');
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
    const scope = { mergedIntoId: null, deletedAt: null, AND: [filter] };

    const includePhone = opts.includePhone !== false;
    const schema = includePhone ? ['EMAIL', 'PHONE'] : ['EMAIL'];

    // find-or-create the sync row so a re-sync reuses the same audience id.
    const existing = await this.prisma.segmentAudienceSync.findUnique({
      where: { segmentId_adAccountId: { segmentId, adAccountId: accountId } },
    });
    let audienceId = existing?.externalAudienceId ?? null;
    if (!audienceId) {
      const created = await createCustomAudience(token, account.externalAdId, {
        name: `CRM: ${segment.name}`.slice(0, 100),
      });
      if (!created.ok || !created.id) {
        await this.recordError(workspaceId, segmentId, accountId, created.error ?? 'create audience failed');
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
        select: {
          emailNormalized: true,
          phoneNormalized: true,
          emailOptOut: true,
          smsOptOut: true,
          emailVerifiedStatus: true,
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: BATCH,
      });
      if (leads.length === 0) break;

      const rows: string[][] = [];
      for (const l of leads) {
        // Consent hygiene (KVKK / Meta Customer List terms): drop opted-out and
        // known-invalid emails before they ever leave the CRM.
        const em =
          !l.emailOptOut && l.emailVerifiedStatus !== 'INVALID' ? sha256(l.emailNormalized) : undefined;
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
          await this.recordError(workspaceId, segmentId, accountId, res.error ?? 'upload failed');
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

    // Lookalike is sequenced AFTER the seed uploads. Best-effort: it fails until
    // Meta has matched enough users, so a failure is recorded, not thrown.
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

    await this.prisma.segmentAudienceSync.upsert({
      where: { segmentId_adAccountId: { segmentId, adAccountId: accountId } },
      create: {
        workspaceId,
        segmentId,
        adAccountId: accountId,
        provider: 'META',
        externalAudienceId: audienceId,
        lookalikeAudienceId: lookalikeId,
        status: 'SYNCED',
        lastCount: uploaded,
        lastSyncedAt: new Date(),
        lastError: null,
      },
      update: {
        externalAudienceId: audienceId,
        lookalikeAudienceId: lookalikeId,
        status: 'SYNCED',
        lastCount: uploaded,
        lastSyncedAt: new Date(),
        lastError: null,
      },
    });

    return { audienceId, uploaded, received, invalid, lookalikeId, status: 'SYNCED' };
  }

  /** Read the current sync state for a segment+account (or null). */
  status(workspaceId: string, segmentId: string, accountId: string) {
    return this.prisma.segmentAudienceSync.findFirst({
      where: { workspaceId, segmentId, adAccountId: accountId },
    });
  }

  private async recordError(workspaceId: string, segmentId: string, adAccountId: string, error: string) {
    await this.prisma.segmentAudienceSync
      .upsert({
        where: { segmentId_adAccountId: { segmentId, adAccountId } },
        create: { workspaceId, segmentId, adAccountId, provider: 'META', status: 'ERROR', lastError: error.slice(0, 500) },
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
