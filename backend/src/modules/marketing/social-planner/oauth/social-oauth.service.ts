import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../../common/crypto/secret-box.helper';
import {
  Network,
  isOAuthNetwork,
  isOAuthConfigured,
  usesPkce,
} from './social-oauth.config';
import { signState, verifyState, generatePkce } from './social-oauth-state.util';
import { buildAuthorizeUrl, providerFor, ConnectableAsset } from './social-oauth.providers';
import { ChannelsService } from '../../channels/channels.service';
import { AdAccountService } from '../../ads/ad-account.service';
import { ConnectAdAccountDto } from '../../dto/ad-account.dto';
import { metaGraphFetch } from '../../../../common/util/meta-graph.util';
import { EntitlementsService } from '../../../billing/entitlements.service';

const PENDING_TTL_MS = 15 * 60 * 1000;

interface SealedPayload {
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
  assets: ConnectableAsset[];
}

/**
 * The SocialAccount.network must reflect the ASSET, not the OAuth flow it arrived
 * through. Meta's single Login-for-Business returns BOTH Facebook Pages and linked
 * Instagram accounts, and the flow may have been started as either FACEBOOK or
 * INSTAGRAM — so a Page could otherwise be stored under INSTAGRAM. The publisher
 * routes by `network` (FACEBOOK → Page /feed, INSTAGRAM → IG /media), so a Page
 * mis-tagged INSTAGRAM silently fails to publish. Map the account type to its
 * canonical network; other providers have a single asset type → keep the fallback.
 */
function resolveSocialNetwork(accountType: string, fallback: string): string {
  if (accountType === 'PAGE') return 'FACEBOOK';
  if (accountType === 'IG_BUSINESS') return 'INSTAGRAM';
  return fallback;
}

/**
 * Orchestrates the OAuth connect flow: builds the signed authorize URL,
 * handles the provider callback (exchange → list assets → stash a sealed
 * pending row), and turns the user's asset selection into sealed SocialAccount
 * rows. Workspace-scoped; tokens never leave sealed except in-memory during
 * the exchange.
 */
@Injectable()
export class SocialOAuthService {
  private readonly logger = new Logger(SocialOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
    private readonly ads: AdAccountService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private assertNetwork(network: string): Network {
    if (!isOAuthNetwork(network)) {
      throw new BadRequestException(`Unsupported network: ${network}`);
    }
    return network;
  }

  start(
    workspaceId: string,
    network: string,
    origin?: 'social' | 'channels' | 'account-center',
  ): { authorizeUrl: string } {
    const n = this.assertNetwork(network);
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Cannot connect: MARKETING_SECRET_KEY is not configured');
    }
    if (!isOAuthConfigured(n)) {
      throw new BadRequestException(`${n} is not configured — the platform app credentials are missing`);
    }
    // PKCE networks (X): mint a verifier/challenge, SEAL the verifier into the
    // signed state (so the callback can recover it without a server session),
    // and put only the S256 challenge on the authorize URL.
    if (usesPkce(n)) {
      const { verifier, challenge } = generatePkce();
      const state = signState({ workspaceId, network: n, cv: sealSecret(verifier), origin });
      return { authorizeUrl: buildAuthorizeUrl(n, state, challenge) };
    }
    const state = signState({ workspaceId, network: n, origin });
    return { authorizeUrl: buildAuthorizeUrl(n, state) };
  }

  async handleCallback(
    network: string,
    code: string,
    state: string,
  ): Promise<{ pendingId: string; workspaceId: string; origin?: 'social' | 'channels' | 'account-center' }> {
    const n = this.assertNetwork(network);
    const payload = verifyState(state);
    if (!payload || payload.network !== n) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    // Recover the sealed PKCE verifier from the (signed, tamper-proof) state for
    // PKCE networks; a tampered/missing verifier simply fails the exchange.
    let codeVerifier: string | undefined;
    if (usesPkce(n) && payload.cv) {
      try {
        codeVerifier = openSecret(payload.cv);
      } catch {
        throw new BadRequestException('Invalid or expired OAuth state');
      }
    }
    const provider = providerFor(n);
    const exchange = await provider.exchangeCode(n, code, codeVerifier);
    const assets = await provider.listAssets(exchange.accessToken);

    const sealed = sealSecret(
      JSON.stringify({
        token: exchange.accessToken,
        refreshToken: exchange.refreshToken ?? null,
        expiresAt: exchange.expiresAt ? exchange.expiresAt.toISOString() : null,
        assets,
      } satisfies SealedPayload),
    );

    const pending = await this.prisma.pendingSocialConnection.create({
      data: {
        workspaceId: payload.workspaceId,
        network: n,
        payload: sealed,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
    return { pendingId: pending.id, workspaceId: payload.workspaceId, origin: payload.origin };
  }

  private async loadPending(workspaceId: string, id: string) {
    const row = await this.prisma.pendingSocialConnection.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException('Pending connection not found');
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This connection attempt expired — please reconnect');
    }
    return row;
  }

  /** The asset list to choose from — tokens stripped. */
  async listPending(workspaceId: string, id: string) {
    const row = await this.loadPending(workspaceId, id);
    const data = JSON.parse(openSecret(row.payload)) as SealedPayload;
    return {
      network: row.network,
      assets: (data.assets ?? []).map((a) => ({
        externalId: a.externalId,
        displayName: a.displayName,
        accountType: a.accountType,
      })),
    };
  }

  /**
   * Provision the chosen assets by kind: Pages/IG → a sealed SocialAccount
   * (publishing), optionally ALSO a messaging Channel when opted in via
   * `provisionMessaging`; WhatsApp numbers → a WHATSAPP Channel; ad accounts →
   * an AdAccount. Messaging Channels + ad accounts go through the owning
   * services (ChannelsService.create / AdAccountService.connect) so their
   * collision guards + sealing run. A per-asset failure (e.g. a (type,externalId)
   * already owned by another workspace) is collected in `skipped` rather than
   * aborting the whole confirm. Deletes the pending row when done.
   */
  async confirm(
    workspaceId: string,
    id: string,
    selected: string[],
    provisionMessaging: string[] = [],
  ) {
    const row = await this.loadPending(workspaceId, id);
    const data = JSON.parse(openSecret(row.payload)) as SealedPayload;
    const chosen = (data.assets ?? []).filter((a) => selected.includes(a.externalId));
    if (chosen.length === 0) {
      throw new BadRequestException('Select at least one account to connect');
    }
    const tokenExpiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    const sealedRefresh = data.refreshToken ? sealSecret(data.refreshToken) : null;

    const summary = {
      socialAccounts: 0,
      channels: 0,
      adAccounts: 0,
      skipped: [] as { externalId: string; reason: string }[],
    };

    // Minting a messaging Channel (Meta DM or WhatsApp) is gated on the SAME
    // conversationAi entitlement the marketing/channels API enforces — otherwise
    // this OAuth path would be a backdoor that creates a live inbox the operator
    // can't manage (the channels API 403s for an unentitled plan). Publishing
    // SocialAccounts + ad accounts stay ungated.
    const canMessaging = (await this.entitlements.getEffective(workspaceId)).features.conversationAi;
    const gateMessaging = (externalId: string) => {
      summary.skipped.push({ externalId, reason: 'messaging: conversationAi feature not in plan' });
    };

    for (const asset of chosen) {
      const token = asset.token ?? data.token;
      try {
        if (asset.accountType === 'WHATSAPP_NUMBER') {
          if (!canMessaging) {
            gateMessaging(asset.externalId);
            continue;
          }
          await this.provisionWhatsAppChannel(workspaceId, asset, token);
          summary.channels++;
        } else if (asset.accountType === 'AD_ACCOUNT') {
          await this.provisionAdAccount(workspaceId, asset, token);
          summary.adAccounts++;
        } else {
          const network = resolveSocialNetwork(asset.accountType, row.network);
          await this.upsertSocialAccount(workspaceId, network, asset, token, tokenExpiresAt, sealedRefresh);
          summary.socialAccounts++;
          if (
            provisionMessaging.includes(asset.externalId) &&
            (asset.accountType === 'PAGE' || asset.accountType === 'IG_BUSINESS')
          ) {
            if (!canMessaging) {
              gateMessaging(asset.externalId);
            } else {
              try {
                await this.provisionMetaMessagingChannel(workspaceId, asset, token);
                summary.channels++;
              } catch (e: any) {
                summary.skipped.push({ externalId: asset.externalId, reason: `messaging: ${e?.message ?? e}` });
              }
            }
          }
        }
      } catch (e: any) {
        summary.skipped.push({ externalId: asset.externalId, reason: String(e?.message ?? e) });
      }
    }

    await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } });
    const connected = summary.socialAccounts + summary.channels + summary.adAccounts;
    return { connected, ...summary };
  }

  private upsertSocialAccount(
    workspaceId: string,
    network: string,
    asset: ConnectableAsset,
    token: string,
    tokenExpiresAt: Date | null,
    sealedRefresh: string | null,
  ) {
    const fields = {
      displayName: asset.displayName,
      accessToken: sealSecret(token),
      tokenExpiresAt,
      refreshToken: sealedRefresh,
      accountType: asset.accountType,
      connectedVia: 'OAUTH',
      enabled: true,
      lastError: null,
    };
    return this.prisma.socialAccount.upsert({
      where: {
        workspaceId_network_externalId: { workspaceId, network, externalId: asset.externalId },
      },
      create: { workspaceId, network, externalId: asset.externalId, ...fields },
      update: fields,
    });
  }

  private async provisionMetaMessagingChannel(workspaceId: string, asset: ConnectableAsset, token: string) {
    const type = asset.accountType === 'IG_BUSINESS' ? 'INSTAGRAM' : 'MESSENGER';
    const channel = await this.channels.create(workspaceId, {
      type,
      name: asset.displayName,
      externalId: asset.externalId,
      secrets: { pageAccessToken: token },
    });
    // Subscribe the owning Page to our app's messaging webhook — without this,
    // inbound DMs are never delivered (same reason the WhatsApp signup subscribes
    // the WABA). For an IG business account the subscription lives on the LINKED
    // PAGE (asset.meta.pageId); for a Page it's the page itself. Best-effort: the
    // channel row already exists, so a subscribe failure (e.g. the Meta app lacks
    // pages_manage_metadata / messaging permissions until App Review) is logged,
    // not fatal — re-verifying the channel later can re-subscribe.
    const pageId = type === 'INSTAGRAM' ? String(asset.meta?.pageId ?? asset.externalId) : asset.externalId;
    // Truly best-effort: the channel row is already persisted, so neither a
    // graceful Graph error (sub.ok === false) NOR a transport throw (timeout /
    // DNS / SSRF from metaGraphFetch) may propagate — that would divert an
    // already-created channel into `skipped` and, on retry, hit the (type,
    // externalId) collision guard forever. Log and move on; re-verify re-subscribes.
    try {
      const sub = await metaGraphFetch(`/${pageId}/subscribed_apps`, {
        accessToken: token,
        method: 'POST',
        // `leadgen` delivers Meta Lead Ads (Instant Form) submissions on this
        // same page webhook (MetaWebhookController routes them to the leadgen
        // ingest). Inert until the app holds leads_retrieval/pages_manage_ads.
        query: { subscribed_fields: 'messages,messaging_postbacks,message_reactions,leadgen' },
      });
      if (!sub.ok) {
        this.logger.warn(
          `Messaging webhook subscribe for page ${pageId} (${type}) failed: ${sub.error?.message ?? sub.status}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`Messaging webhook subscribe for page ${pageId} (${type}) errored: ${e?.message ?? e}`);
    }
    return channel;
  }

  private provisionWhatsAppChannel(workspaceId: string, asset: ConnectableAsset, token: string) {
    const phoneNumberId = String(asset.meta?.phoneNumberId ?? asset.externalId);
    return this.channels.create(workspaceId, {
      type: 'WHATSAPP',
      name: asset.displayName,
      externalId: phoneNumberId,
      secrets: { accessToken: token, phoneNumberId },
    });
  }

  private provisionAdAccount(workspaceId: string, asset: ConnectableAsset, token: string) {
    const dto = {
      provider: 'META',
      externalAdId: String(asset.meta?.accountId ?? asset.externalId),
      displayName: asset.displayName,
      accessToken: token,
      currency: (asset.meta?.currency as string) ?? undefined,
    } as ConnectAdAccountDto;
    return this.ads.connect(workspaceId, dto);
  }
}
