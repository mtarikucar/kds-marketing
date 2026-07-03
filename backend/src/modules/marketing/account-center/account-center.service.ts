import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialPlannerService } from '../social-planner/social-planner.service';
import { ChannelsService } from '../channels/channels.service';
import { AdAccountService } from '../ads/ad-account.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { SocialOAuthService } from '../social-planner/oauth/social-oauth.service';

/**
 * Account Center (hesap merkezi) — a READ-MODEL that aggregates every external
 * account/connection a workspace has (social publishing, messaging inbox,
 * WhatsApp, ads) into one normalized, provider-grouped list. It performs NO
 * writes and never opens sealed secrets — it only reads the already-masked list
 * DTOs each owning service exposes, so multi-tenant scoping + secret masking are
 * inherited for free.
 *
 * The one identity fact it exploits: for a shared Meta asset the FB Page id / IG
 * business id is the SAME `externalId` on both the SocialAccount (PUBLISH) and the
 * Channel (INBOX) — so those collapse into a single card that shows both
 * capabilities, instead of the same page appearing twice in two disconnected UIs.
 */

export type Capability = 'PUBLISH' | 'INBOX' | 'ADS' | 'WHATSAPP' | 'CALLS';
export type Provider =
  | 'META'
  | 'LINKEDIN'
  | 'TIKTOK'
  | 'TWITTER'
  | 'PINTEREST'
  | 'GOOGLE'
  | 'SMS'
  | 'EMAIL'
  | 'WEBCHAT'
  | 'VOICE';
export type Health = 'HEALTHY' | 'REAUTH_REQUIRED' | 'DISABLED' | 'PARTIAL';

export interface SourceRef {
  capability: Capability;
  model: 'SocialAccount' | 'Channel' | 'AdAccount';
  id: string;
  status: string;
  /** For messaging channels: the setup URL to paste into the provider dashboard
   *  (Meta webhook / NetGSM inbound / email inbound) — surfaced HERE (where you
   *  connect) rather than on the channels page. setupKind lets the SPA localize
   *  the label. */
  setupUrl?: string | null;
  setupKind?: 'META_WEBHOOK' | 'SMS_CALLBACK' | 'EMAIL_WEBHOOK' | 'TIKTOK_WEBHOOK';
  /** WEBCHAT only — the SPA builds the embed <script> snippet from this. */
  widgetKey?: string | null;
}

export interface ConnectionGroup {
  identityKey: string;
  externalId: string | null;
  displayName: string;
  connectedVia: 'OAUTH' | 'MANUAL';
  capabilities: Capability[];
  health: Health;
  sources: SourceRef[];
}

export interface ProviderBlock {
  provider: Provider;
  displayName: string;
  connectMethod: 'OAUTH' | 'MANUAL';
  configured: boolean;
  connections: ConnectionGroup[];
}

export interface AccountCenterResponse {
  secretBoxConfigured: boolean;
  features: { conversationAi: boolean };
  networkStatus: Record<string, boolean>;
  providers: ProviderBlock[];
}

/** SocialAccount.network → the Account Center provider bucket. */
const SOCIAL_PROVIDER: Record<string, Provider> = {
  FACEBOOK: 'META',
  INSTAGRAM: 'META',
  LINKEDIN: 'LINKEDIN',
  TIKTOK: 'TIKTOK',
  TWITTER: 'TWITTER',
  PINTEREST: 'PINTEREST',
  GMB: 'GOOGLE',
};

/** Channel.type → provider bucket + the capability it powers. */
const CHANNEL_PROVIDER: Record<string, Provider> = {
  MESSENGER: 'META',
  INSTAGRAM: 'META',
  WHATSAPP: 'META',
  TIKTOK: 'TIKTOK',
  LINKEDIN: 'LINKEDIN',
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WEBCHAT: 'WEBCHAT',
  VOICE: 'VOICE',
};
const CHANNEL_CAPABILITY: Record<string, Capability> = {
  MESSENGER: 'INBOX',
  INSTAGRAM: 'INBOX',
  WHATSAPP: 'WHATSAPP',
  TIKTOK: 'INBOX',
  LINKEDIN: 'INBOX',
  SMS: 'INBOX',
  EMAIL: 'INBOX',
  WEBCHAT: 'INBOX',
  VOICE: 'CALLS',
};
const AD_PROVIDER: Record<string, Provider> = { META: 'META', TIKTOK: 'TIKTOK', LINKEDIN: 'LINKEDIN' };

/** Reauth/reconnect routes an identity back through the right social OAuth network. */
const PROVIDER_NETWORK: Partial<Record<Provider, string>> = {
  META: 'FACEBOOK',
  LINKEDIN: 'LINKEDIN',
  TIKTOK: 'TIKTOK',
  TWITTER: 'TWITTER',
  PINTEREST: 'PINTEREST',
  GOOGLE: 'GMB',
};

/** The full provider catalog, in display order — always emitted (even with zero
 *  connections) so the hub is a complete "connect anything" catalog. */
const CATALOG: { provider: Provider; displayName: string; connectMethod: 'OAUTH' | 'MANUAL' }[] = [
  { provider: 'META', displayName: 'Meta — Facebook, Instagram, WhatsApp & Ads', connectMethod: 'OAUTH' },
  { provider: 'LINKEDIN', displayName: 'LinkedIn', connectMethod: 'OAUTH' },
  { provider: 'TIKTOK', displayName: 'TikTok', connectMethod: 'OAUTH' },
  { provider: 'TWITTER', displayName: 'X (Twitter)', connectMethod: 'OAUTH' },
  { provider: 'PINTEREST', displayName: 'Pinterest', connectMethod: 'OAUTH' },
  { provider: 'GOOGLE', displayName: 'Google Business Profile', connectMethod: 'OAUTH' },
  { provider: 'SMS', displayName: 'SMS (NetGSM)', connectMethod: 'MANUAL' },
  { provider: 'EMAIL', displayName: 'Email', connectMethod: 'MANUAL' },
  { provider: 'WEBCHAT', displayName: 'Web chat', connectMethod: 'MANUAL' },
  { provider: 'VOICE', displayName: 'Voice', connectMethod: 'MANUAL' },
];

@Injectable()
export class AccountCenterService {
  constructor(
    private readonly socialPlanner: SocialPlannerService,
    private readonly channels: ChannelsService,
    private readonly adAccounts: AdAccountService,
    private readonly entitlements: EntitlementsService,
    private readonly socialOAuth: SocialOAuthService,
  ) {}

  /** Re-resolve a group server-side by its identityKey (never trust client ids). */
  private async findGroup(workspaceId: string, identityKey: string): Promise<ConnectionGroup> {
    const model = await this.getConnections(workspaceId);
    const group = model.providers
      .flatMap((p) => p.connections)
      .find((g) => g.identityKey === identityKey);
    if (!group) throw new NotFoundException('Connection not found');
    return group;
  }

  /**
   * Capability-selective disconnect. Re-resolves the identity, then fans out to
   * the owning service's per-model removal for each source (optionally filtered to
   * the requested capabilities — so a user can drop just INBOX while keeping
   * PUBLISH). Each removal is workspace-scoped by the underlying service; a
   * per-source failure is collected in `skipped`, never aborting the rest.
   */
  async disconnect(
    workspaceId: string,
    identityKey: string,
    capabilities?: Capability[],
  ): Promise<{ removed: SourceRef[]; skipped: (SourceRef & { reason: string })[] }> {
    const group = await this.findGroup(workspaceId, identityKey);
    const targets = capabilities?.length
      ? group.sources.filter((s) => capabilities.includes(s.capability))
      : group.sources;

    const removed: SourceRef[] = [];
    const skipped: (SourceRef & { reason: string })[] = [];
    for (const s of targets) {
      try {
        if (s.model === 'SocialAccount') await this.socialPlanner.disconnectAccount(workspaceId, s.id);
        else if (s.model === 'Channel') await this.channels.remove(workspaceId, s.id);
        else if (s.model === 'AdAccount') await this.adAccounts.remove(workspaceId, s.id);
        removed.push(s);
      } catch (e: any) {
        skipped.push({ ...s, reason: String(e?.message ?? e) });
      }
    }
    return { removed, skipped };
  }

  /**
   * Reconnect/reauth: returns the same authorize URL the connect start would, for
   * the identity's provider. The confirm step upserts on the existing unique keys,
   * so re-auth rotates tokens in place and clears `lastError` — no new plumbing.
   */
  reauth(workspaceId: string, identityKey: string): { authorizeUrl: string } {
    const provider = identityKey.split(':')[0] as Provider;
    const network = PROVIDER_NETWORK[provider];
    if (!network) {
      throw new BadRequestException('Reconnect is only available for OAuth providers');
    }
    return this.socialOAuth.start(workspaceId, network, 'account-center');
  }

  async getConnections(workspaceId: string): Promise<AccountCenterResponse> {
    const [socials, channels, ads, netStatus, adStatus, ent] = await Promise.all([
      this.socialPlanner.listAccounts(workspaceId),
      this.channels.list(workspaceId),
      this.adAccounts.list(workspaceId),
      this.socialPlanner.networkStatus(workspaceId),
      Promise.resolve(this.adAccounts.status()),
      this.entitlements.getEffective(workspaceId),
    ]);

    // provider → identityKey → group (Maps preserve insertion order).
    const groups = new Map<Provider, Map<string, ConnectionGroup>>();
    const ensure = (
      provider: Provider,
      externalId: string | null,
      fallbackId: string,
      displayName: string,
      connectedVia: 'OAUTH' | 'MANUAL',
    ): ConnectionGroup => {
      // Shared Meta assets collapse by externalId (page/IG id); rows without a
      // provider identity get a per-row synthetic key so they stay distinct.
      const key = `${provider}:${externalId ?? fallbackId}`;
      let byKey = groups.get(provider);
      if (!byKey) groups.set(provider, (byKey = new Map()));
      let g = byKey.get(key);
      if (!g) {
        g = {
          identityKey: key,
          externalId: externalId ?? null,
          displayName,
          connectedVia,
          capabilities: [],
          health: 'HEALTHY',
          sources: [],
        };
        byKey.set(key, g);
      }
      return g;
    };
    const addCap = (g: ConnectionGroup, cap: Capability) => {
      if (!g.capabilities.includes(cap)) g.capabilities.push(cap);
    };

    // 1) Social publishing accounts → PUBLISH.
    for (const a of socials as any[]) {
      const provider = SOCIAL_PROVIDER[a.network] ?? 'META';
      const g = ensure(provider, a.externalId, a.id, a.displayName, a.connectedVia === 'OAUTH' ? 'OAUTH' : 'MANUAL');
      addCap(g, 'PUBLISH');
      g.sources.push({ capability: 'PUBLISH', model: 'SocialAccount', id: a.id, status: a.enabled === false ? 'DISABLED' : 'ACTIVE' });
      if (a.lastError === 'reauth_required') g.health = 'REAUTH_REQUIRED';
      else if (a.enabled === false && g.health === 'HEALTHY') g.health = 'DISABLED';
    }

    // 2) Messaging channels → INBOX / WHATSAPP / CALLS.
    for (const c of channels as any[]) {
      const provider = CHANNEL_PROVIDER[c.type] ?? 'WEBCHAT';
      const cap = CHANNEL_CAPABILITY[c.type] ?? 'INBOX';
      const oauthish = provider === 'META' || provider === 'LINKEDIN' || provider === 'TIKTOK';
      const g = ensure(provider, c.externalId ?? null, c.id, c.name, oauthish ? 'OAUTH' : 'MANUAL');
      addCap(g, cap);
      const src: SourceRef = { capability: cap, model: 'Channel', id: c.id, status: c.status };
      // Surface the "paste this to finish connecting" URL here (it's a connection
      // step, not channel management). channels.list() masks these per type.
      if (c.type === 'MESSENGER' || c.type === 'INSTAGRAM' || c.type === 'WHATSAPP') {
        src.setupUrl = c.webhookUrl ?? null;
        src.setupKind = 'META_WEBHOOK';
      } else if (c.type === 'SMS') {
        src.setupUrl = c.callbackUrl ?? null;
        src.setupKind = 'SMS_CALLBACK';
      } else if (c.type === 'EMAIL') {
        src.setupUrl = c.webhookUrl ?? null;
        src.setupKind = 'EMAIL_WEBHOOK';
      } else if (c.type === 'TIKTOK') {
        src.setupUrl = c.webhookUrl ?? null;
        src.setupKind = 'TIKTOK_WEBHOOK';
      } else if (c.type === 'WEBCHAT') {
        src.widgetKey = c.widgetKey ?? null;
      }
      g.sources.push(src);
      if (c.status === 'DISABLED' && g.health === 'HEALTHY') g.health = 'DISABLED';
    }

    // 3) Ad accounts → ADS.
    for (const ad of ads as any[]) {
      const provider = AD_PROVIDER[ad.provider] ?? 'META';
      const g = ensure(provider, ad.externalAdId, ad.id, ad.displayName ?? ad.externalAdId, 'OAUTH');
      addCap(g, 'ADS');
      g.sources.push({ capability: 'ADS', model: 'AdAccount', id: ad.id, status: ad.status });
      if (ad.status === 'TOKEN_EXPIRED') g.health = 'REAUTH_REQUIRED';
    }

    // Fold PARTIAL: a group that mixes a healthy source with a broken one.
    for (const byKey of groups.values()) {
      for (const g of byKey.values()) {
        const broken = g.sources.some(
          (s) => s.status === 'DISABLED' || s.status === 'TOKEN_EXPIRED',
        );
        const healthy = g.sources.some((s) => s.status === 'ACTIVE');
        if (g.health === 'HEALTHY' && broken && healthy) g.health = 'PARTIAL';
      }
    }

    const configuredFor = (p: Provider): boolean => {
      switch (p) {
        case 'META':
          return !!netStatus?.FACEBOOK || !!adStatus?.META;
        case 'LINKEDIN':
          return !!netStatus?.LINKEDIN || !!adStatus?.LINKEDIN;
        case 'TIKTOK':
          return !!netStatus?.TIKTOK || !!adStatus?.TIKTOK;
        case 'TWITTER':
          return !!netStatus?.TWITTER;
        case 'PINTEREST':
          return !!netStatus?.PINTEREST;
        case 'GOOGLE':
          return !!netStatus?.GMB;
        default:
          return true; // manual providers need no platform app
      }
    };

    const providers: ProviderBlock[] = CATALOG.map((c) => ({
      provider: c.provider,
      displayName: c.displayName,
      connectMethod: c.connectMethod,
      configured: configuredFor(c.provider),
      connections: Array.from(groups.get(c.provider)?.values() ?? []),
    }));

    return {
      secretBoxConfigured: !!netStatus?.secretBoxConfigured,
      features: { conversationAi: !!ent.features.conversationAi },
      networkStatus: (netStatus ?? {}) as Record<string, boolean>,
      providers,
    };
  }
}
