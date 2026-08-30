import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The people a workspace IS working a deal for — the complement of the board's
 * leftmost column.
 *
 * ## Why the column exists
 *
 * Measured on the live workspace the day this was written: 363 people, 2 deals,
 * one of them a synthetic `[TEST]` row. 361 people are outside the pipeline and
 * that fact appears on NO screen. Opening the board only to people who already
 * have a deal keeps the silent majority silent — which is exactly today's state
 * and the reason the pipeline is empty.
 *
 * ## "No OPEN opportunity", stated
 *
 * `status = 'OPEN'` and nothing else. A person whose only deal is WON, LOST or
 * ABANDONED is NOT in the pipeline: they are past it or out of it, and someone
 * has to decide what happens next — which is what the column is for. Reading it
 * as "has never had a deal" would hide every closed-and-quiet customer, the very
 * group most worth a second deal.
 *
 * The predicate is deliberately NOT `stage.isWon/isLost`: `status` is the column
 * the service keeps in sync with those flags, and the column every other read in
 * `opportunities.service.ts` filters on (`board`, `forecast`). Two definitions of
 * "open" in one product is the "which one is right?" question that costs a day.
 *
 * ## Why raw SQL, and why an id list
 *
 * `Opportunity.leadId` is a bare `String?` with NO foreign key and no Prisma
 * relation (schema.prisma:3931), exactly like `Conversation.leadId`. There is no
 * relation to `include`, no `some` to nest and no `_count` to ask for, so the
 * anti-join is hand-written and stitched back on — the same two-step
 * `waiting-reply-leads.ts` and `lead-activity-enrichment.ts` already do.
 *
 * ## Why this returns the people WITH a deal, not the people without
 *
 * The obvious shape is the complement: `SELECT leads WHERE NOT EXISTS (…)`, fed
 * to Prisma as `id: { in: … }`. It was written that way first and then changed,
 * for two reasons that are worth the paragraph:
 *
 * 1. **Every tenant predicate has to be able to fail on its own.** The
 *    complement form needs `leads."workspaceId"` in the SQL *and* `workspaceId`
 *    on the Prisma read; either one alone already keeps a neighbour's person
 *    out, so deleting one leaves the suite green — the doubly-guarded fixture
 *    this repo has been bitten by before. Asking the database only "who has an
 *    open deal?" leaves exactly one workspace predicate on each side, and each
 *    one fails its own assertion in the real-DB e2e.
 *
 * 2. **It is the smaller list.** Bounded by the number of OPEN DEALS (2 live),
 *    not by the number of people (361). The `@@index([workspaceId, status])`
 *    already exists and covers it exactly.
 *
 * The trade is that the caller uses `notIn`, so the "empty list must not mean
 * everything" trap moves rather than disappearing — see the two guards below and
 * `notInPipeline()`.
 *
 * ## `leadId IS NOT NULL` is load-bearing, not tidiness
 *
 * A deal with no person attached is legal and common (the API allows it;
 * `orphanCard` in the e2e is one), and it yields a NULL in this list. Measured
 * by deleting the filter and running the suite: Prisma REJECTS the request —
 * `Argument notIn: Invalid value provided. Expected ListStringFieldRefInput,
 * provided (String, String, Null)` — so ONE nameless deal takes the entire
 * column down with a 500 rather than emptying it quietly. Loud, but still
 * total: the column stops working for a reason that has nothing to do with the
 * people in it. (Written by hand in SQL the same NULL would be silent, since
 * `x NOT IN (NULL, …)` is never true; the filter guards both readings.)
 *
 * ## The missing foreign key is a tenant hazard
 *
 * Nothing stops an opportunity row in workspace B naming a lead id belonging to
 * workspace A. `o."workspaceId"` here is what keeps a NEIGHBOUR's open deal from
 * hiding OUR person from the only screen built to surface them — it reads as
 * harmless and is not. The real-DB e2e keeps a row shaped precisely like that.
 */
export async function leadIdsWithOpenOpportunity(
  prisma: PrismaService,
  workspaceId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ leadId: string | null }>>`
    SELECT DISTINCT o."leadId" AS "leadId"
    FROM "opportunities" o
    WHERE o."workspaceId" = ${workspaceId}
      AND o."status" = 'OPEN'
      AND o."leadId" IS NOT NULL
  `;
  return rows.map((r) => r.leadId).filter((id): id is string => !!id);
}
