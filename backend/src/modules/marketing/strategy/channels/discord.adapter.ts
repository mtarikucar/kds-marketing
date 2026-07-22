import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../../../prisma/prisma.service';

/**
 * Discord community channel adapter — publishes ONE native message to a Discord
 * server via an Incoming Webhook.
 *
 * SAFETY / ToS: auto-posting marketing into Discord servers you do NOT own (or
 * are not explicitly authorized to post in) violates Discord's ToS + almost every
 * server's rules. This adapter is therefore intended ONLY for a Discord server
 * you control, reached through a server-issued Incoming Webhook URL. Live posting
 * is opt-in and creds-gated: when no webhook is configured the executor stages a
 * human-review DRAFT instead of posting (the safe default). This mirrors the
 * `isNetworkConfigured` gating the X/Pinterest social publishers use — everything
 * here is INERT until a webhook URL exists.
 */
const logger = new Logger('DiscordAdapter');

export interface ChannelPostResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Resolve the Incoming Webhook URL this workspace posts its OWNED-server community
 * content to, or null when none is configured (→ stage a draft).
 *
 * Storage decision: there is no per-workspace Discord webhook column in the schema
 * yet, and adding one is a separate migration outside this change's scope. For now
 * we read a single global webhook from env `DISCORD_WEBHOOK_URL`. The
 * `(workspaceId, prisma)` signature is deliberately kept so a future per-workspace
 * lookup (a `ChannelSecret` row / workspace-settings JSON) can slot in here without
 * touching any caller.
 *
 * ENV to add (deploy.yml — do NOT edit it here, documented only): `DISCORD_WEBHOOK_URL`
 * — a Discord Incoming Webhook URL for the OWNED server, e.g.
 * `https://discord.com/api/webhooks/<id>/<token>`.
 */
export async function resolveDiscordWebhookUrl(
  _workspaceId: string,
  _prisma?: PrismaService,
): Promise<string | null> {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  return url ? url : null;
}

/** True when this workspace has a Discord webhook to post to (else stage a draft). */
export async function isDiscordConfigured(workspaceId: string, prisma?: PrismaService): Promise<boolean> {
  return !!(await resolveDiscordWebhookUrl(workspaceId, prisma));
}

/**
 * POST `{ content }` to a Discord Incoming Webhook (plain fetch, no SDK). Appends
 * `wait=true` so Discord responds with the created message object (including its
 * `id`) instead of an empty 204, letting us return a `resultRef`. Any non-2xx or
 * thrown error degrades to `{ ok:false, error }` — the caller then stages a draft.
 */
export async function postToDiscord(
  webhookUrl: string,
  { content }: { content: string },
): Promise<ChannelPostResult> {
  try {
    const url = webhookUrl.includes('?') ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Discord webhook HTTP ${res.status} ${body}`.trim().slice(0, 500) };
    }
    // 204 (no wait / empty body) has no JSON — tolerate the parse failure.
    const json = await res.json().catch(() => ({}) as Record<string, unknown>);
    const id = (json as Record<string, unknown>)?.id;
    return { ok: true, id: id ? String(id) : undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`Discord webhook post error: ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}
