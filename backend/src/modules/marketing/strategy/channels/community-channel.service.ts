import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../../common/crypto/secret-box.helper';

export type CommunityProvider = 'DISCORD' | 'REDDIT';
const PROVIDERS: CommunityProvider[] = ['DISCORD', 'REDDIT'];

/** Reddit requires a descriptive, unique User-Agent on every API request. */
export const REDDIT_USER_AGENT = 'web:jeeta-growth-strategy-engine:v1 (community-engage)';
const REDDIT_AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_ME_URL = 'https://oauth.reddit.com/api/v1/me';

/** The platform Reddit app client creds (shared, one app), or undefined when unset. */
export function redditClientId(): string | undefined {
  return process.env.REDDIT_CLIENT_ID;
}
export function redditClientSecret(): string | undefined {
  return process.env.REDDIT_CLIENT_SECRET;
}
/** True when the platform Reddit OAuth app is configured (env creds present). */
export function isRedditEnvConfigured(): boolean {
  return !!(redditClientId() && redditClientSecret());
}
/** HTTP Basic header for Reddit's confidential-client token endpoint. */
export function redditBasicAuth(): string {
  const raw = `${redditClientId() ?? ''}:${redditClientSecret() ?? ''}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}
/** The Reddit OAuth redirect URI — must be registered verbatim in the Reddit app. */
export function redditRedirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/strategy/channels/reddit/callback`;
}

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

  // ──────────────────────────────────────────────────────────── Reddit (Task 3)

  /**
   * Build the Reddit authorize URL for the OWNED-account connect flow. `state` is
   * the caller's signed CSRF/tenant token (recovered in the callback). Gated on the
   * platform Reddit app creds — throws if unconfigured so the UI can stay inert.
   * `duration=permanent` yields a refresh token; scope `submit identity` is the
   * minimum to post a self-post + read the connected username.
   */
  redditAuthorizeUrl(_workspaceId: string, state: string): { url: string } {
    if (!isRedditEnvConfigured()) {
      throw new BadRequestException('Reddit is not configured — REDDIT_CLIENT_ID/SECRET are missing');
    }
    const p = new URLSearchParams({
      client_id: redditClientId() ?? '',
      response_type: 'code',
      state,
      redirect_uri: redditRedirectUri(),
      duration: 'permanent',
      scope: 'submit identity',
    });
    return { url: `${REDDIT_AUTHORIZE_URL}?${p.toString()}` };
  }

  /**
   * Exchange the OAuth `code` for a token bundle, seal it into the REDDIT config
   * row, and record the connected username (non-secret meta). Throws on exchange
   * failure so the callback can redirect with an error.
   */
  async handleRedditCallback(workspaceId: string, code: string): Promise<CommunityConnectionView> {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Cannot connect: MARKETING_SECRET_KEY is not configured');
    }
    if (!isRedditEnvConfigured()) {
      throw new BadRequestException('Reddit is not configured — REDDIT_CLIENT_ID/SECRET are missing');
    }
    const bundle = await this.redditTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redditRedirectUri(),
    });
    const username = await this.fetchRedditUsername(bundle.access).catch(() => undefined);
    const meta = username ? { username } : undefined;
    const row = await this.upsert(workspaceId, 'REDDIT', sealSecret(JSON.stringify(bundle)), meta);
    return this.toView(row);
  }

  /** Unseal this workspace's Reddit token bundle, or null when not connected. */
  async getRedditToken(workspaceId: string): Promise<RedditTokenBundle | null> {
    const row = await this.prisma.communityChannelConfig.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: 'REDDIT' } },
    });
    if (!row || row.status !== 'ACTIVE' || !row.sealedSecret) return null;
    try {
      return JSON.parse(openSecret(row.sealedSecret)) as RedditTokenBundle;
    } catch (e) {
      this.logger.warn(`Reddit token unseal failed for ws ${workspaceId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Re-seal a refreshed Reddit token bundle back into the config row. */
  async saveRedditToken(workspaceId: string, bundle: RedditTokenBundle): Promise<void> {
    await this.prisma.communityChannelConfig.update({
      where: { workspaceId_provider: { workspaceId, provider: 'REDDIT' } },
      data: { sealedSecret: sealSecret(JSON.stringify(bundle)) },
    });
  }

  /** Exchange/refresh grant → normalized token bundle. Throws on any failure. */
  async redditTokenRequest(form: Record<string, string>): Promise<RedditTokenBundle> {
    const res = await fetch(REDDIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: redditBasicAuth(),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': REDDIT_USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new BadRequestException(`Reddit token HTTP ${res.status} ${body}`.trim().slice(0, 500));
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const access = json?.access_token ? String(json.access_token) : '';
    if (!access) throw new BadRequestException('Reddit token: no access_token returned');
    const expiresIn = typeof json?.expires_in === 'number' ? json.expires_in : 3600;
    return {
      access,
      // A refresh grant may omit refresh_token — the caller preserves the old one.
      refresh: json?.refresh_token ? String(json.refresh_token) : String(form.refresh_token ?? ''),
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  private async fetchRedditUsername(accessToken: string): Promise<string | undefined> {
    const res = await fetch(REDDIT_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'user-agent': REDDIT_USER_AGENT },
    });
    if (!res.ok) return undefined;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return json?.name ? String(json.name) : undefined;
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
