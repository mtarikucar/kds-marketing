-- Manual rollback for 20260715150000_workspace_memberships (Prisma migrate is
-- forward-only). No data loss: MarketingUser.workspaceId/role were retained, so
-- dropping the join table reverts to the single-workspace model exactly.
DROP TABLE IF EXISTS "workspace_memberships";
