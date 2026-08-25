-- Recover phone numbers the researcher already found.
--
-- A lead's `externalRef` is a dedup key, but its `phone:` form is literally the
-- contact itself, already shape-validated as E.164 by EXTERNAL_REF_PATTERN
-- (`phone:\+[1-9]\d{6,14}`) when it was ingested.
--
-- The research model fills the ref reliably (it is required) and the matching
-- `phone` field only sometimes. Measured on this database: of 301 leads
-- carrying a `phone:` ref, 33 had a NULL phone — a number already found, and
-- already paid for in research credits, sitting in the key and nowhere the
-- product could use it. Those leads read as uncontactable.
--
-- research-worker now derives this at ingest, so this repairs only rows written
-- before that.
--
-- `phoneNormalized` is written in the same statement. It is the Epic A4
-- duplicate-detection match key (indexed on (workspaceId, phoneNormalized)) and
-- normalizePhone() is a pure digit-strip, so the equivalent here is stripping
-- every non-digit. Setting `phone` without it would leave a lead findable by
-- number but invisible to duplicate detection.
--
-- Strictly additive: guarded on `phone IS NULL`, so nothing a human or a
-- provider supplied is overwritten. Nothing here can fail on existing rows.
--
-- NOTE: `leads` has no website/instagram column — those live in the
-- ResearchCandidate row and are folded into the lead's notes text at ingest, so
-- there is nothing to backfill for them here.

UPDATE "leads"
SET "phone" = substring("externalRef" from 7),
    "phoneNormalized" = regexp_replace(substring("externalRef" from 7), '[^0-9]', '', 'g')
WHERE "phone" IS NULL
  AND "externalRef" LIKE 'phone:+%';
