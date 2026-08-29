import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The leads a workspace OWES a reply to — the "Bekleyen" work-queue chip.
 *
 * "Waiting" is `status = 'OPEN' AND lastInboundAt >= lastMessageAt`: the
 * customer was the last one to write and nobody has answered. This is not a new
 * definition; it is the one DailyDigestService already ships, already covers
 * with a real-DB e2e, and already says out loud every morning ("N konuşma yanıt
 * bekliyor — müşteri en son yazan taraf"). Two definitions of "waiting" in one
 * product is the "which one is right?" question this spec exists to stop
 * creating, so this reads from the same predicate rather than inventing a
 * second one.
 *
 * Explicitly NOT `unreadCount > 0`: that column is zeroed by LOOKING
 * (ConversationsService.markRead, which the inbox POSTs automatically the
 * moment a thread is selected), so a rep who opens a thread and walks away
 * clears the badge without answering anyone. The chip exists to surface
 * neglect, and unread measures attention, not answers.
 *
 * Raw SQL because the predicate is a COLUMN COMPARISON, which Prisma's `where`
 * cannot express; a two-step id list because `conversations` carries no foreign
 * key to `leads` (schema.prisma declares a bare `leadId String` with no
 * relation), so there is no nested `some` to write.
 *
 * Cost, measured against local Postgres with 50 000 leads / 20 000
 * conversations of which 4 000 are waiting (this product's live figure is 2):
 * the DISTINCT query is 6.5 ms, the page read 0.5 ms and the count 18 ms, with
 * ~156 KB of ids on the wire. Affordable at 2000x the real workload.
 */
export async function waitingReplyLeadIds(
  prisma: PrismaService,
  workspaceId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ leadId: string }>>`
    SELECT DISTINCT "leadId"
    FROM "conversations"
    WHERE "workspaceId" = ${workspaceId}
      AND "status" = 'OPEN'
      AND "lastInboundAt" IS NOT NULL
      AND ("lastMessageAt" IS NULL OR "lastInboundAt" >= "lastMessageAt")
  `;
  return rows.map((r) => r.leadId);
}
