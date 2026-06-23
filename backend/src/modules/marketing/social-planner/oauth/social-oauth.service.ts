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
} from './social-oauth.config';
import { signState, verifyState } from './social-oauth-state.util';
import { buildAuthorizeUrl, providerFor, ConnectableAsset } from './social-oauth.providers';
import { ChannelsService } from '../../channels/channels.service';
import { AdAccountService } from '../../ads/ad-account.service';
import { ConnectAdAccountDto } from '../../dto/ad-account.dto';

const PENDING_TTL_MS = 15 * 60 * 1000;

interface SealedPayload {
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
  assets: ConnectableAsset[];
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
  ) {}

  private assertNetwork(network: string): Network {
    if (!isOAuthNetwork(network)) {
      throw new BadRequestException(`Unsupported network: ${network}`);
    }
    return network;
  }

  start(workspaceId: string, network: string): { authorizeUrl: string } {
    const n = this.assertNetwork(network);
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Cannot connect: MARKETING_SECRET_KEY is not configured');
    }
    if (!isOAuthConfigured(n)) {
      throw new BadRequestException(`${n} is not configured — the platform app credentials are missing`);
    }
    const state = signState({ workspaceId, network: n });
    return { authorizeUrl: buildAuthorizeUrl(n, state) };
  }

  async handleCallback(
    network: string,
    code: string,
    state: string,
  ): Promise<{ pendingId: string; workspaceId: string }> {
    const n = this.assertNetwork(network);
    const payload = verifyState(state);
    if (!payload || payload.network !== n) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    const provider = providerFor(n);
    const exchange = await provider.exchangeCode(n, code);
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
    return { pendingId: pending.id, workspaceId: payload.workspaceId };
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

    for (const asset of chosen) {
      const token = asset.token ?? data.token;
      try {
        if (asset.accountType === 'WHATSAPP_NUMBER') {
          await this.provisionWhatsAppChannel(workspaceId, asset, token);
          summary.channels++;
        } else if (asset.accountType === 'AD_ACCOUNT') {
          await this.provisionAdAccount(workspaceId, asset, token);
          summary.adAccounts++;
        } else {
          await this.upsertSocialAccount(workspaceId, row.network, asset, token, tokenExpiresAt, sealedRefresh);
          summary.socialAccounts++;
          if (
            provisionMessaging.includes(asset.externalId) &&
            (asset.accountType === 'PAGE' || asset.accountType === 'IG_BUSINESS')
          ) {
            try {
              await this.provisionMetaMessagingChannel(workspaceId, asset, token);
              summary.channels++;
            } catch (e: any) {
              summary.skipped.push({ externalId: asset.externalId, reason: `messaging: ${e?.message ?? e}` });
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

  private provisionMetaMessagingChannel(workspaceId: string, asset: ConnectableAsset, token: string) {
    const type = asset.accountType === 'IG_BUSINESS' ? 'INSTAGRAM' : 'MESSENGER';
    return this.channels.create(workspaceId, {
      type,
      name: asset.displayName,
      externalId: asset.externalId,
      secrets: { pageAccessToken: token },
    });
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
