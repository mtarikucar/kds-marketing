import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../../common/crypto/secret-box.helper';

export type CommunityProvider = 'DISCORD' | 'REDDIT';
const PROVIDERS: CommunityProvider[] = ['DISCORD', 'REDDIT'];

/** The Reddit token bundle we seal per-workspace (never stored raw). */
export interface RedditTokenBundle {
  access: string;
  refresh: string;
  /** epoch ms the access token expires at (0 / past → refresh before use). */
  expiresAt: number;
}

/** A non-secret summary of a connection for the list/settings UI. */
export interface CommunityConnectionView {
  provider: CommunityProvider;
  status: string;
  connectedAt: Date;
  meta: Record<string, unknown> | null;
}

/**
 * Per-workspace connected community channels for the COMMUNITY_ENGAGE executor.
 *
 * SAFETY / ToS: OWNED channels only — a workspace connects ITS OWN Discord server
 * (an Incoming Webhook it issued) and ITS OWN Reddit account (OAuth). Auto-posting
 * marketing into servers/subreddits you do not control violates Discord/Reddit ToS.
 * Everything here is INERT until a workspace connects; the executor stages a
 * human-review draft when a channel is unconfigured.
 *
 * Secrets are AES-256-GCM sealed via secret-box.helper (the SAME seal used for
 * SocialAccount tokens / PSP keys) — the DB row never holds a raw webhook URL or
 * Reddit token. `meta` carries only non-secret display context.
 */
@Injectable()
export class CommunityChannelService {
  private readonly logger = new Logger(CommunityChannelService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────── Discord (Task 2)

  /**
   * Connect (or re-connect) a workspace's OWNED Discord server via an Incoming
   * Webhook URL. Validates the URL is a Discord webhook, seals it, and upserts
   * the DISCORD config row. `channelName` (optional) is stored as display meta.
   */
  async connectDiscord(
    workspaceId: string,
    webhookUrl: string,
    channelName?: string,
  ): Promise<CommunityConnectionView> {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Cannot connect: MARKETING_SECRET_KEY is not configured');
    }
    const url = (webhookUrl ?? '').trim();
    if (!this.isDiscordWebhookUrl(url)) {
      throw new BadRequestException(
        'Not a valid Discord Incoming Webhook URL (expected https://discord.com/api/webhooks/<id>/<token>)',
      );
    }
    const meta = channelName?.trim() ? { channelName: channelName.trim() } : undefined;
    const row = await this.upsert(workspaceId, 'DISCORD', sealSecret(url), meta);
    return this.toView(row);
  }

  /** The unsealed Discord webhook URL for this workspace, or null when none is connected. */
  async getDiscordWebhook(workspaceId: string): Promise<string | null> {
    const row = await this.prisma.communityChannelConfig.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: 'DISCORD' } },
    });
    if (!row || row.status !== 'ACTIVE' || !row.sealedSecret) return null;
    try {
      return openSecret(row.sealedSecret);
    } catch (e) {
      this.logger.warn(`Discord webhook unseal failed for ws ${workspaceId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Discord webhook host allowlist — canonical + PTB/canary + legacy discordapp.com. */
  private isDiscordWebhookUrl(raw: string): boolean {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    const ok =
      host === 'discord.com' ||
      host === 'discordapp.com' ||
      host === 'ptb.discord.com' ||
      host === 'canary.discord.com';
    return ok && /^\/api(\/v\d+)?\/webhooks\/\d+\/.+/.test(u.pathname);
  }

  // ─────────────────────────────────────────────────────── generic connections

  /** Non-secret list of this workspace's connected community channels. */
  async listConnections(workspaceId: string): Promise<CommunityConnectionView[]> {
    const rows = await this.prisma.communityChannelConfig.findMany({
      where: { workspaceId },
      orderBy: { provider: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  /** Disconnect a provider (deletes the sealed row). Idempotent. */
  async disconnect(workspaceId: string, provider: string): Promise<{ disconnected: boolean }> {
    const p = this.assertProvider(provider);
    const res = await this.prisma.communityChannelConfig.deleteMany({
      where: { workspaceId, provider: p },
    });
    return { disconnected: res.count > 0 };
  }

  private assertProvider(provider: string): CommunityProvider {
    const p = (provider ?? '').toUpperCase();
    if (!(PROVIDERS as string[]).includes(p)) {
      throw new BadRequestException(`Unsupported community provider: ${provider}`);
    }
    return p as CommunityProvider;
  }

  private upsert(
    workspaceId: string,
    provider: CommunityProvider,
    sealedSecret: string,
    meta?: Record<string, unknown>,
  ) {
    const data = { sealedSecret, status: 'ACTIVE', meta: meta ?? undefined };
    return this.prisma.communityChannelConfig.upsert({
      where: { workspaceId_provider: { workspaceId, provider } },
      create: { workspaceId, provider, ...data },
      update: data,
    });
  }

  private toView(row: {
    provider: string;
    status: string;
    createdAt: Date;
    meta: unknown;
  }): CommunityConnectionView {
    return {
      provider: row.provider as CommunityProvider,
      status: row.status,
      connectedAt: row.createdAt,
      meta: (row.meta as Record<string, unknown> | null) ?? null,
    };
  }
}
