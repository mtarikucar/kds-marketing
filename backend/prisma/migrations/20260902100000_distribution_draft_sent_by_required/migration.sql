-- The send boundary, as a CONSTRAINT rather than as a convention.
--
-- 20260901220000's header already argued for this in prose: "A SENT row with a
-- null `sentById` would be evidence of exactly the behaviour this design
-- forbids, which is why the pair exists rather than a lone timestamp." It was
-- an argument, not a rule. This makes it a rule.
--
-- WHY THE FILE SCAN WAS NOT ENOUGH. `distribution-send.boundary.spec.ts` walks
-- the source tree and fails when a file outside a written-down list names
-- `DistributionSendService` or `OutboundConversationService`. That is a scan for
-- two NAMES. A caller that skips both — a scheduled job that dispatches through
-- `MessageSenderService` directly and then writes `status: 'SENT'` with a null
-- `sentById` — was added to the distribution folder during review and the whole
-- suite stayed green: 593 suites, 6618 tests, nothing caught it. The scan
-- measures who is MENTIONED; this measures what is TRUE of the data, which no
-- future caller can route around.
--
-- WHY THIS SHAPE AND NOT A NOT NULL COLUMN. `sentById` must stay nullable: a
-- DRAFT, a DISMISSED and a FAILED row all legitimately have nobody attached to
-- them, and a FAILED row is one whose send was ATTEMPTED and did not land — the
-- send path clears `sentAt` and writes the reason instead. The invariant is
-- conditional, so the constraint is conditional. `status <> 'SENT' OR "sentById"
-- IS NOT NULL` is the whole of it: only the one status that means "this went to
-- a real person" demands a person.
--
-- VALIDATED, NOT `NOT VALID`. `distribution_drafts` is created by 20260901220000
-- in this same unreleased branch, so every environment that runs this has zero
-- rows in it. If some environment somehow does hold a violating row, this
-- migration failing loudly is the correct outcome: that row is the evidence the
-- header describes, and deploying past it silently would be the one thing this
-- constraint exists to prevent.
--
-- INVISIBLE TO THE PARITY GATE. Prisma's datamodel cannot express a CHECK, so
-- `prisma migrate diff --from-migrations --to-schema-datamodel` neither sees nor
-- reports it; the gate was run against this file and still says "No difference
-- detected". The schema comment on `DistributionDraft.sentById` is therefore the
-- only place a Prisma-only reader learns this exists, and it names the
-- constraint so the next reader can find it.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'distribution_drafts_sent_by_present'
    ) THEN
        ALTER TABLE "distribution_drafts"
            ADD CONSTRAINT "distribution_drafts_sent_by_present"
            CHECK ("status" <> 'SENT' OR "sentById" IS NOT NULL);
    END IF;
END
$$;
