import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** The four `ConsentRecord.type` values the product writes (schema.prisma). */
export type ConsentType = 'MARKETING_EMAIL' | 'MARKETING_SMS' | 'MARKETING_WHATSAPP' | 'DATA_PROCESSING';

export interface ConsentLedgerEntry {
  workspaceId: string;
  /** Every lead the one physical decision applies to (an address can be on
   *  file more than once — that is the whole point of address-level consent). */
  leadIds: string[];
  type: ConsentType;
  /** false = withdrawn (opted out), true = given back. */
  granted: boolean;
  source?: string | null;
  ipAddress?: string | null;
}

/**
 * Writes `ConsentRecord` rows. Nothing else.
 *
 * The repo's own rule (mcp/tools/consent.tools.ts:20-27) is that an opt-out
 * flag is never flipped without a dated record behind it, and
 * `SuppressionService` now flips those flags for EVERY lead that shares an
 * address — so the ledger has to be widened with it.
 *
 * What this deliberately does NOT do is reuse `ComplianceService.recordConsent`
 * for that widening. Its SMS branch appends an outbox row AND an İYS job under
 * their own idempotency keys, so calling it once per same-address lead would
 * enqueue N blacklist syncs and N İYS RET jobs for ONE physical click
 * (`optout-per-lead-row`). The eventing belongs to the single clicked
 * recipient; the audit trail belongs to every matching lead. This service is
 * the second half, side-effect free, and takes the caller's transaction so the
 * rows commit with the flag flip that produced them.
 */
@Injectable()
export class ConsentLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns how many rows were written (0 when there is nothing to record). */
  async record(entry: ConsentLedgerEntry, tx?: Prisma.TransactionClient): Promise<number> {
    const leadIds = [...new Set((entry.leadIds ?? []).filter((id): id is string => !!id))];
    if (!entry.workspaceId || !leadIds.length) return 0;

    const db = tx ?? this.prisma;
    const res = await db.consentRecord.createMany({
      data: leadIds.map((leadId) => ({
        workspaceId: entry.workspaceId,
        leadId,
        type: entry.type,
        granted: entry.granted,
        source: entry.source ?? null,
        ipAddress: entry.ipAddress ?? null,
      })),
    });
    return res.count;
  }
}
