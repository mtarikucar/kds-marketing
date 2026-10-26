-- Read-only export. Prisma Lead maps to leads; column names retain their case.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset pager off
SELECT row_to_json(allowed)::text
FROM (
    SELECT "id", "businessName", "contactPerson", "phone", "whatsapp", "email", "address", "city", "region", "businessType", "tableCount", "branchCount", "currentSystem", "source", "status", "lostReason", "notes", "nextFollowUp", "priority", "customFields", "emailOptOut", "smsOptOut", "waOptOut", "emailBouncedAt", "createdAt", "updatedAt"
    FROM leads
    WHERE "workspaceId" = :'v1_workspace_id'
      AND "deletedAt" IS NULL AND "mergedIntoId" IS NULL
    ORDER BY "createdAt", "id"
) AS allowed;
