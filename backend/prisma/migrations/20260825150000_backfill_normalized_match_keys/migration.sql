-- Backfill the Epic A4 duplicate-detection match keys.
--
-- `mapToLeadData` writes phoneNormalized/emailNormalized on every lead it
-- creates, so the live ingest path is correct. Rows written before those
-- assignments existed were not repaired, and a lead with a phone but no
-- phoneNormalized is invisible to duplicate detection: the same business can be
-- re-ingested under a different externalRef and nothing notices.
--
-- Measured on this database after the externalRef recovery: 12 leads carried a
-- phone with a NULL phoneNormalized, all AI_RESEARCH.
--
-- normalizePhone() is a pure digit-strip (it drops `+`, spaces and dashes and
-- keeps a leading `00`), and normalizeEmail() trims and lowercases — mirrored
-- exactly here. Guarded on the normalized column being NULL, so a value already
-- computed by the application is never rewritten, and empty results are left
-- NULL rather than stored as '' so "absent" keeps meaning absent.

UPDATE "leads"
SET "phoneNormalized" = NULLIF(regexp_replace("phone", '[^0-9]', '', 'g'), '')
WHERE "phone" IS NOT NULL
  AND "phoneNormalized" IS NULL;

UPDATE "leads"
SET "emailNormalized" = NULLIF(lower(btrim("email")), '')
WHERE "email" IS NOT NULL
  AND "emailNormalized" IS NULL;
