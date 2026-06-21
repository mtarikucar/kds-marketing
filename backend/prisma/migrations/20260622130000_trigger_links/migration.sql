-- Migration: Standalone Trigger Links + click tracking (GoHighLevel parity)
--
-- A trackable short link that 302s to a target URL and emits a link.clicked
-- workflow trigger per click. `slug` is globally unique (the public /l/:slug
-- route has no workspace context). New tables only — additive.

-- CreateTable
CREATE TABLE "trigger_links" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "targetUrl"   TEXT NOT NULL,
    "clickCount"  INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trigger_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_link_clicks" (
    "id"            TEXT NOT NULL,
    "workspaceId"   TEXT NOT NULL,
    "triggerLinkId" TEXT NOT NULL,
    "leadId"        TEXT,
    "ip"            TEXT,
    "userAgent"     TEXT,
    "clickedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_link_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trigger_links_slug_key" ON "trigger_links"("slug");
CREATE INDEX "trigger_links_workspaceId_idx" ON "trigger_links"("workspaceId");
CREATE INDEX "trigger_link_clicks_triggerLinkId_clickedAt_idx" ON "trigger_link_clicks"("triggerLinkId", "clickedAt");
CREATE INDEX "trigger_link_clicks_workspaceId_clickedAt_idx" ON "trigger_link_clicks"("workspaceId", "clickedAt");

-- AddForeignKey
ALTER TABLE "trigger_link_clicks" ADD CONSTRAINT "trigger_link_clicks_triggerLinkId_fkey" FOREIGN KEY ("triggerLinkId") REFERENCES "trigger_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
