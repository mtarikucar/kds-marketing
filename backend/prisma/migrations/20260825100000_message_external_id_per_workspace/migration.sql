-- Scope the provider message id to the workspace.
--
-- `externalMessageId` was globally @unique, but a provider only guarantees its
-- message ids are unique within one business/page/account. Two tenants can
-- therefore legitimately receive the same id, and the global index made that a
-- collision.
--
-- ConversationIngressService already refused to leak: its dedup lookup is
-- workspace-scoped, so a foreign hit falls through, and the P2002 handler
-- re-resolves scoped and re-throws when it finds nothing rather than handing
-- back a foreign conversation id. Correct, but the cost is that the second
-- tenant's webhook fails and their message never lands — the ingress comment
-- names this exact composite as the follow-up.
--
-- No data cleanup needed: the composite constraint is strictly WEAKER than the
-- global one it replaces, so any data that satisfied the old index satisfies
-- this one. (Postgres treats NULLs as distinct in both.)

DROP INDEX IF EXISTS "messages_externalMessageId_key";

CREATE UNIQUE INDEX "messages_workspaceId_externalMessageId_key"
  ON "messages" ("workspaceId", "externalMessageId");
