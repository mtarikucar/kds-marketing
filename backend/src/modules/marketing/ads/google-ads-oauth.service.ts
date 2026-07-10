import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  isSecretBoxConfigured,
  sealSecret,
  openSecret,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch } from '../../../common/util/safe-fetch';
import { signState, verifyState } from '../social-planner/oauth/social-oauth-state.util';
import {
  isGoogleAdsConfigured,
  buildGoogleAdsAuthorizeUrl,
  googleAdsRedirectUri,
  GOOGLE_ADS_TOKEN_URL,
} from './google-ads-oauth.config';
import { googleAdsFetch, normalizeCustomerId } from './google-ads.util';
import { AdAccountService } from './ad-account.service';

const NETWORK = 'google-ads';
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface GoogleAdAccountInfo {
  externalAdId: string; // customer id (digits)
  displayName: string;
  currency: string | null;
}

interface PendingPayload {
  // The long-lived OAuth REFRESH token — sealed into AdAccount.accessToken on
  // connect; the Google client mints ~1h access tokens from it per call.
  refreshToken: string;
  accounts: GoogleAdAccountInfo[];
}

/**
 * One-click Google-Ads OAuth → ad-account provisioning, in the ads module.
 * Confidential client with `access_type=offline` so the exchange yields a
 * refresh token. Inert until GOOGLE_ADS_* creds + MARKETING_SECRET_KEY are set.
 * Mirrors the LinkedIn ads OAuth trio.
 */
@Injectable()
export class GoogleAdsOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adAccounts: AdAccountService,
  ) {}

  /** Step 1: build the Google authorize URL bound to this workspace. */
  async start(workspaceId: string): Promise<{ authorizeUrl: string }> {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    if (!isGoogleAdsConfigured()) {
      throw new BadRequestException('Google ads app credentials are not configured on this platform');
    }
    const state = signState({ workspaceId, network: NETWORK });
    return { authorizeUrl: buildGoogleAdsAuthorizeUrl(state) };
  }

  /**
   * Step 2: callback — verify state, exchange the code for {access, refresh},
   * list the accessible customers, seal {refreshToken, accounts} into a
   * 15-minute PendingSocialConnection.
   */
  async handleCallback(code: string, state: string): Promise<{ pendingId: string; workspaceId: string }> {
    const parsed = verifyState(state);
    if (!parsed || parsed.network !== NETWORK) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    const { workspaceId } = parsed;

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.GOOGLE_ADS_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? '',
      redirect_uri: googleAdsRedirectUri(),
    });
    const tokenRes = await safeFetch(GOOGLE_ADS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: 20_000,
    });
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    const accessToken: string = tokenJson?.access_token;
    const refreshToken: string = tokenJson?.refresh_token;
    if (!accessToken || !refreshToken) {
      throw new BadRequestException('Google token exchange failed: missing access/refresh token');
    }

    const accounts = await this.listAccessibleCustomers(accessToken);

    const payload: PendingPayload = { refreshToken, accounts };
    const row = await this.prisma.pendingSocialConnection.create({
      data: {
        workspaceId,
        network: NETWORK,
        payload: sealSecret(JSON.stringify(payload)),
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
    return { pendingId: row.id, workspaceId };
  }

  /**
   * GET customers:listAccessibleCustomers → resourceNames ['customers/123', …].
   * Best-effort per customer, a GAQL query fetches descriptiveName + currency.
   */
  private async listAccessibleCustomers(accessToken: string): Promise<GoogleAdAccountInfo[]> {
    const listRes = await googleAdsFetch('customers:listAccessibleCustomers', { accessToken, method: 'GET' });
    if (!listRes.ok) {
      throw new BadRequestException('Google accessible-customer lookup failed');
    }
    const names: string[] = Array.isArray(listRes.data?.resourceNames) ? listRes.data.resourceNames : [];
    const ids = names.map((n) => normalizeCustomerId(n)).filter(Boolean);

    return Promise.all(
      ids.map(async (id): Promise<GoogleAdAccountInfo> => {
        try {
          const r = await googleAdsFetch(`customers/${id}/googleAds:searchStream`, {
            accessToken,
            method: 'POST',
            body: { query: 'SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1' },
            loginCustomerId: id,
          });
          const batch = Array.isArray(r.data) ? r.data[0] : r.data;
          const c = batch?.results?.[0]?.customer;
          if (r.ok && c) {
            return { externalAdId: id, displayName: c.descriptiveName ?? id, currency: c.currencyCode ?? null };
          }
        } catch {
          // best-effort
        }
        return { externalAdId: id, displayName: id, currency: null };
      }),
    );
  }

  private async loadPendingRow(workspaceId: string, id: string) {
    const row = await this.prisma.pendingSocialConnection.findFirst({
      where: { id, workspaceId, network: NETWORK },
    });
    if (!row) throw new BadRequestException('Pending connection not found or expired');
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } }).catch(() => undefined);
      throw new BadRequestException('Pending connection not found or expired');
    }
    return row;
  }

  /** Step 3: return the connectable customers (NEVER the refresh token). */
  async listPending(workspaceId: string, id: string): Promise<{ accounts: GoogleAdAccountInfo[] }> {
    const row = await this.loadPendingRow(workspaceId, id);
    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;
    return { accounts: payload.accounts };
  }

  /** Step 4: provision the selected customers (refresh token → sealed accessToken). */
  async confirm(workspaceId: string, id: string, selected: string[]): Promise<{ connected: number }> {
    const row = await this.loadPendingRow(workspaceId, id);
    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;

    const selectedSet = new Set(selected);
    const toConnect = payload.accounts.filter((a) => selectedSet.has(a.externalAdId));

    for (const acc of toConnect) {
      await this.adAccounts.connect(workspaceId, {
        provider: 'GOOGLE',
        externalAdId: acc.externalAdId,
        accessToken: payload.refreshToken, // sealed → the Google client refreshes from it
        displayName: acc.displayName,
        currency: acc.currency ?? undefined,
      });
    }

    await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } });
    return { connected: toConnect.length };
  }
}
