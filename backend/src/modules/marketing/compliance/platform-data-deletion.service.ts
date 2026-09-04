import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { parseMetaSignedRequest } from '../../../common/util/meta-signed-request.util';
import { ComplianceService } from './compliance.service';

/**
 * Meta's **Data Deletion Request Callback** — the endpoint Meta requires an app
 * to answer before it will accept an App Review submission. Meta POSTs a
 * `signed_request` and expects `{ url, confirmation_code }` back, where `url` is
 * a page the person can open to see what happened to their request.
 *
 * ── What Meta actually sends, and why matching is not guaranteed ─────────────
 * The signed payload carries a **platform-scoped** `user_id`:
 *  - For a **Facebook Login** app it is the **app-scoped user id (ASID)** — a
 *    per-(app, person) identifier that lives in a DIFFERENT namespace from the
 *    **page-scoped id (PSID)** the Messenger webhook hands us. Converting one to
 *    the other is Meta's ID Matching API (`/{asid}/ids_for_pages`), which needs
 *    a *user* access token — exactly the thing a deletion callback does not
 *    carry, and exactly the thing a person who just revoked the app no longer
 *    has. So for the Facebook app this id usually will NOT match anything we
 *    store, and that has to be said out loud rather than papered over.
 *  - For an **Instagram API with Instagram Login** app the id IS the
 *    Instagram-scoped user id — the same value we store as `IGSID`. There the
 *    match is real.
 *
 * Hence: we look the id up against the identities we genuinely hold (PSID,
 * IGSID), erase every lead it resolves to, and when it resolves to nothing we
 * record an **UNMATCHED** request. We never answer "deleted" for data we never
 * found; the status page tells the person exactly that.
 *
 * ── Reuse, not a second deletion path ────────────────────────────────────────
 * The erasure itself is ComplianceService.requestErasure + fulfillErasure —
 * the audited, transactional, workspace-scoped path the dashboard uses. This
 * service only resolves and records; it never deletes a row itself.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The `signed_request`, the app secret and the raw platform user id are NEVER
 * logged, echoed or persisted. The stored subject is a SHA-256 digest.
 */

/** The Meta-issued identities we actually store on ContactIdentity. */
const META_IDENTITY_KINDS = ['PSID', 'IGSID'] as const;

/** Meta re-delivers a callback it did not get a clean answer to. Inside this
 *  window the same subject is answered with the SAME confirmation code rather
 *  than a second record whose "UNMATCHED" would misdescribe the first one's
 *  successful deletion. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PlatformDeletionAck {
  url: string;
  confirmation_code: string;
}

export interface PublicDeletionStatus {
  confirmationCode: string;
  status: string;
  receivedAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class PlatformDataDeletionService {
  private readonly logger = new Logger(PlatformDataDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly compliance: ComplianceService,
  ) {}

  /**
   * Verify → resolve → erase → record. `baseUrl` is the public origin the status
   * link is built on (PUBLIC_BASE_URL, or the request's own origin as fallback).
   */
  async handleMetaRequest(signedRequest: string, baseUrl: string): Promise<PlatformDeletionAck> {
    const parsed = parseMetaSignedRequest(signedRequest);
    if (!parsed.ok) {
      // Log the REASON only — never the request, the payload or the id.
      this.logger.warn(`meta data-deletion callback refused: ${parsed.reason}`);
      if (parsed.reason === 'not_configured') {
        throw new ServiceUnavailableException('Meta app credentials are not configured');
      }
      if (parsed.reason === 'malformed') {
        throw new BadRequestException('signed_request is malformed');
      }
      throw new ForbiddenException('signed_request verification failed');
    }

    const subjectHash = createHash('sha256').update(parsed.userId).digest('hex');

    // Meta retry → same answer. (A row older than the window starts a new
    // request: a person may genuinely ask twice, months apart.)
    const existing = await this.prisma.platformDeletionRequest.findFirst({
      where: {
        platform: 'META',
        subjectHash,
        receivedAt: { gte: new Date(Date.now() - RETRY_WINDOW_MS) },
      },
      orderBy: { receivedAt: 'desc' },
    });
    if (existing) {
      return { url: this.statusUrl(baseUrl, existing.confirmationCode), confirmation_code: existing.confirmationCode };
    }

    const confirmationCode = randomBytes(12).toString('hex');
    // Record BEFORE erasing: if anything below throws, the request still exists
    // and the status page can say "received" honestly instead of losing it.
    const record = await this.prisma.platformDeletionRequest.create({
      data: { platform: 'META', subjectHash, confirmationCode, status: 'RECEIVED' },
    });

    // The ONE deliberately cross-workspace read in this file: a platform
    // callback carries no tenant context, so the identity probe has to ask
    // "which tenants hold this id at all". Everything after it is scoped to the
    // workspaceId the matched row itself carries — never a caller-supplied one.
    const identities = await this.prisma.contactIdentity.findMany({
      where: { kind: { in: [...META_IDENTITY_KINDS] }, value: parsed.userId },
      select: { workspaceId: true, leadId: true },
    });

    // One erasure per (workspace, lead): the same person can hold a PSID and an
    // IGSID that both point at one lead.
    const targets = new Map<string, { workspaceId: string; leadId: string }>();
    for (const i of identities) targets.set(`${i.workspaceId}:${i.leadId}`, i);

    if (targets.size === 0) {
      await this.prisma.platformDeletionRequest.update({
        where: { id: record.id },
        data: { status: 'UNMATCHED', matchedLeads: 0, completedAt: new Date() },
      });
      this.logger.log(
        `meta data-deletion request ${confirmationCode}: no stored identity matched — recorded UNMATCHED`,
      );
      return { url: this.statusUrl(baseUrl, confirmationCode), confirmation_code: confirmationCode };
    }

    const dataRequestIds: string[] = [];
    let failed = false;
    for (const { workspaceId, leadId } of targets.values()) {
      try {
        const req = await this.compliance.requestErasure(workspaceId, leadId);
        await this.compliance.fulfillErasure(workspaceId, req.id);
        dataRequestIds.push(req.id);
      } catch (e: any) {
        failed = true;
        // No lead id, no workspace-identifying payload beyond the id we already
        // own — and never the platform id.
        this.logger.error(
          `meta data-deletion request ${confirmationCode}: erasure failed for one match: ${e?.message ?? e}`,
        );
      }
    }

    await this.prisma.platformDeletionRequest.update({
      where: { id: record.id },
      data: {
        status: failed ? 'FAILED' : 'COMPLETED',
        matchedLeads: dataRequestIds.length,
        dataRequestIds,
        completedAt: failed ? null : new Date(),
      },
    });

    return { url: this.statusUrl(baseUrl, confirmationCode), confirmation_code: confirmationCode };
  }

  /**
   * Public status of one request. Returns null for an unknown code so the page
   * can say "we have no record of this" — never a blank page implying success.
   * Projects ONLY the four fields the page renders: the subject hash and the
   * internal audit ids stay server-side.
   */
  async statusByCode(code: string): Promise<PublicDeletionStatus | null> {
    if (!code) return null;
    const row = await this.prisma.platformDeletionRequest.findFirst({
      where: { confirmationCode: code },
    });
    if (!row) return null;
    return {
      confirmationCode: row.confirmationCode,
      status: row.status,
      receivedAt: row.receivedAt,
      completedAt: row.completedAt,
    };
  }

  private statusUrl(baseUrl: string, code: string): string {
    return `${(baseUrl ?? '').replace(/\/+$/, '')}/data-deletion-status?code=${encodeURIComponent(code)}`;
  }
}
