-- A workspace's own Anthropic key, sealed at rest.
--
-- An answer is only instant if something can WRITE it the moment the mail
-- lands. The platform key is one shared account (when its credit runs out,
-- every workspace goes silent at once) and the connector cannot be woken —
-- MCP is client-to-server, so it has to be polled. A key belonging to the
-- workspace is present in-process, so the reply is composed on the inbound
-- event itself: no queue, no poll, no shared balance.
-- NB: the physical table is "workspaces" (@@map), not the model name.
ALTER TABLE "workspaces" ADD COLUMN "aiApiKeyEnc" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "aiApiKeySetAt" TIMESTAMP(3);
