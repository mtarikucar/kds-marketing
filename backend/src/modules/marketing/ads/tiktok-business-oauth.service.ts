import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  isSecretBoxConfigured,
  sealSecret,
  openSecret,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch } from '../../../common/util/safe-fetch';
import {
  businessApiBaseUrl,
  tiktokBusinessFetch,
} from '../channels/tiktok-business.util';
import {
  signState,
  verifyState,
} from '../social-planner/oauth/social-oauth-state.util';
import {
  isTiktokBusinessConfigured,
  buildTiktokBusinessAuthorizeUrl,
} from './tiktok-business-oauth.config';
import { AdAccountService } from './ad-account.service';
import { ChannelsService } from '../channels/channels.service';

const NETWORK = 'TIKTOK_BUSINESS';
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface AdvertiserInfo {
  externalAdId: string;
  displayName: string;
  currency: string | null;
}

interface PendingPayload {
  token: string;
  advertisers: AdvertiserInfo[];
  messaging: boolean;
}

export interface ConfirmDto {
  selected: string[];
  enableMessaging?: boolean;
}

@Injectable()
export class TiktokBusinessOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adAccounts: AdAccountService,
    private readonly channels: ChannelsService,
  ) {}

  /** Step 1: Generate the TikTok-for-Business authorize URL. */
  async start(workspaceId: string): Promise<{ authorizeUrl: string }> {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    if (!isTiktokBusinessConfigured()) {
      throw new BadRequestException('TikTok-for-Business app credentials are not configured on this platform');
    }
    const state = signState({ workspaceId, network: NETWORK });
    return { authorizeUrl: buildTiktokBusinessAuthorizeUrl(state) };
  }

  /**
   * Step 2: OAuth callback — exchange the code, fetch advertiser info,
   * seal a PendingSocialConnection row, and return the pendingId for the UI.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ pendingId: string; workspaceId: string }> {
    const parsed = verifyState(state);
    if (!parsed || parsed.network !== NETWORK) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    const { workspaceId } = parsed;

    // Exchange: business API token endpoint (no Access-Token header yet — use safeFetch directly)
    const tokenUrl = `${businessApiBaseUrl()}/oauth2/access_token/`;
    const tokenRes = await safeFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: process.env.TIKTOK_BUSINESS_APP_ID,
        secret: process.env.TIKTOK_BUSINESS_APP_SECRET,
        auth_code: code,
        grant_type: 'authorization_code',
      }),
      timeoutMs: 20_000,
    });
    const tokenJson = await tokenRes.json();
    const token: string = tokenJson?.data?.access_token;
    const advertiserIds: string[] = Array.isArray(tokenJson?.data?.advertiser_ids)
      ? tokenJson.data.advertiser_ids
      : [];
    const scope: string[] = Array.isArray(tokenJson?.data?.scope)
      ? tokenJson.data.scope
      : [];

    if (!token) {
      throw new BadRequestException('TikTok token exchange failed: no access_token in response');
    }

    // Fetch advertiser name + currency (best-effort per advertiser)
    const advertisers: AdvertiserInfo[] = await Promise.all(
      advertiserIds.map(async (id): Promise<AdvertiserInfo> => {
        try {
          const r = await tiktokBusinessFetch<{ list: { name: string; currency: string }[] }>(
            '/advertiser/info/',
            { accessToken: token, query: { advertiser_ids: JSON.stringify([id]) } },
          );
          if (r.ok && r.data?.list?.[0]) {
            return {
              externalAdId: id,
              displayName: r.data.list[0].name ?? id,
              currency: r.data.list[0].currency ?? null,
            };
          }
        } catch {
          // best-effort
        }
        return { externalAdId: id, displayName: id, currency: null };
      }),
    );

    // messaging = any scope string matches /messag/i
    const messaging = scope.some((s) => /messag/i.test(s));

    const payload: PendingPayload = { token, advertisers, messaging };
    const sealedPayload = sealSecret(JSON.stringify(payload));

    const row = await this.prisma.pendingSocialConnection.create({
      data: {
        workspaceId,
        network: NETWORK,
        payload: sealedPayload,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });

    return { pendingId: row.id, workspaceId };
  }

  /** Step 3: Return the advertiser list + messaging flag (NEVER the token). */
  async listPending(
    workspaceId: string,
    id: string,
  ): Promise<{ advertisers: AdvertiserInfo[]; messaging: boolean }> {
    const row = await this.prisma.pendingSocialConnection.findFirst({
      where: { id, workspaceId, network: NETWORK },
    });
    if (!row) throw new BadRequestException('Pending connection not found or expired');

    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;
    return { advertisers: payload.advertisers, messaging: payload.messaging };
  }

  /**
   * Step 4: Provision ad accounts (and optionally a DM channel) from the
   * pending connection, then delete the row.
   */
  async confirm(
    workspaceId: string,
    id: string,
    dto: ConfirmDto,
  ): Promise<{ connectedAdAccounts: number; dmChannel: boolean }> {
    const row = await this.prisma.pendingSocialConnection.findFirst({
      where: { id, workspaceId, network: NETWORK },
    });
    if (!row) throw new BadRequestException('Pending connection not found or expired');

    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;

    const selectedSet = new Set(dto.selected);
    const toConnect = payload.advertisers.filter((a) => selectedSet.has(a.externalAdId));

    for (const adv of toConnect) {
      await this.adAccounts.connect(workspaceId, {
        provider: 'TIKTOK',
        externalAdId: adv.externalAdId,
        accessToken: payload.token,
        displayName: adv.displayName,
        currency: adv.currency ?? undefined,
      });
    }

    let dmChannel = false;
    if (dto.enableMessaging && payload.messaging && toConnect.length > 0) {
      /**
       * V1 PLACEHOLDER: TikTok's API does not expose the business-account ID
       * from the advertiser info response. We use the first selected advertiser
       * ID as the channel externalId so the DM adapter can resolve it via
       * byExternalId(). When TikTok exposes the proper business-account ID
       * (Gate G2 resolved), replace this with the actual account identifier.
       */
      const firstAdvertiserId = toConnect[0].externalAdId;
      try {
        await this.channels.create(workspaceId, {
          type: 'TIKTOK',
          name: 'TikTok DM',
          externalId: firstAdvertiserId,
          secrets: { accessToken: payload.token },
          configPublic: { connectedVia: 'OAUTH', messaging: 'granted' },
        });
        dmChannel = true;
      } catch {
        // Swallow ConflictException (channel already exists) and any other
        // channel creation errors — do NOT abort the ad account provisioning.
        dmChannel = false;
      }
    }

    await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } });

    return { connectedAdAccounts: toConnect.length, dmChannel };
  }
}
