import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  isSecretBoxConfigured,
  sealSecret,
  openSecret,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch } from '../../../common/util/safe-fetch';
import { linkedinRest } from '../../../common/util/linkedin-api.util';
import { signState, verifyState } from '../social-planner/oauth/social-oauth-state.util';
import {
  isLinkedinAdsConfigured,
  buildLinkedinAdsAuthorizeUrl,
  linkedinAdsRedirectUri,
  LINKEDIN_ADS_TOKEN_URL,
} from './linkedin-ads-oauth.config';
import { AdAccountService } from './ad-account.service';

const NETWORK = 'linkedin-ads';
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface LinkedinAdAccountInfo {
  externalAdId: string;
  displayName: string;
  currency: string | null;
}

interface PendingPayload {
  token: string;
  accounts: LinkedinAdAccountInfo[];
}

/**
 * One-click LinkedIn-for-Business (ads) OAuth → ad-account provisioning, in the
 * ads module. CRITICAL BOUNDARY: this is the ADS app, completely separate from
 * the social-planner LinkedIn connect. Confidential client (no PKCE). Inert
 * until LINKEDIN_ADS_CLIENT_ID/SECRET + MARKETING_SECRET_KEY are set.
 */
@Injectable()
export class LinkedinAdsOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adAccounts: AdAccountService,
  ) {}

  /** Step 1: build the LinkedIn ads authorize URL bound to this workspace. */
  async start(workspaceId: string): Promise<{ authorizeUrl: string }> {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    if (!isLinkedinAdsConfigured()) {
      throw new BadRequestException('LinkedIn ads app credentials are not configured on this platform');
    }
    const state = signState({ workspaceId, network: NETWORK });
    return { authorizeUrl: buildLinkedinAdsAuthorizeUrl(state) };
  }

  /**
   * Step 2: OAuth callback — verify state, exchange the code for an access
   * token (form-POST), list the authenticated user's ad accounts (with name +
   * currency), seal {token, accounts} into a 15-minute PendingSocialConnection.
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

    // Exchange code → token (application/x-www-form-urlencoded, confidential client).
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.LINKEDIN_ADS_CLIENT_ID ?? '',
      client_secret: process.env.LINKEDIN_ADS_CLIENT_SECRET ?? '',
      redirect_uri: linkedinAdsRedirectUri(),
    });
    const tokenRes = await safeFetch(LINKEDIN_ADS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: 20_000,
    });
    const tokenJson: any = await tokenRes.json().catch(() => ({}));
    const token: string = tokenJson?.access_token;
    if (!token) {
      throw new BadRequestException('LinkedIn token exchange failed: no access_token in response');
    }

    const accounts = await this.listAdAccounts(token);

    const payload: PendingPayload = { token, accounts };
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
   * GET /rest/adAccountUsers?q=authenticatedUser → each element's `account` is a
   * 'urn:li:sponsoredAccount:{id}'. We then GET /rest/adAccounts/{id} for the
   * name + currency (best-effort per account).
   */
  private async listAdAccounts(token: string): Promise<LinkedinAdAccountInfo[]> {
    const usersRes = await linkedinRest('/rest/adAccountUsers?q=authenticatedUser', {
      accessToken: token,
      method: 'GET',
      timeoutMs: 20_000,
    });
    if (!usersRes.ok) {
      throw new BadRequestException('LinkedIn ad account lookup failed');
    }
    const elements: any[] = Array.isArray(usersRes.data?.elements) ? usersRes.data.elements : [];
    const ids = elements
      .map((el) => {
        const urn = String(el?.account ?? '');
        return urn ? urn.slice(urn.lastIndexOf(':') + 1) : '';
      })
      .filter(Boolean);

    return Promise.all(
      ids.map(async (id): Promise<LinkedinAdAccountInfo> => {
        try {
          const r = await linkedinRest(`/rest/adAccounts/${id}`, {
            accessToken: token,
            method: 'GET',
            timeoutMs: 20_000,
          });
          if (r.ok && r.data) {
            return {
              externalAdId: id,
              displayName: r.data.name ?? id,
              currency: r.data.currency ?? null,
            };
          }
        } catch {
          // best-effort
        }
        return { externalAdId: id, displayName: id, currency: null };
      }),
    );
  }

  /** Load a non-expired pending row scoped to the workspace (deletes if lapsed). */
  private async loadPendingRow(workspaceId: string, id: string) {
    const row = await this.prisma.pendingSocialConnection.findFirst({
      where: { id, workspaceId, network: NETWORK },
    });
    if (!row) throw new BadRequestException('Pending connection not found or expired');
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.pendingSocialConnection
        .delete({ where: { id: row.id } })
        .catch(() => undefined);
      throw new BadRequestException('Pending connection not found or expired');
    }
    return row;
  }

  /** Step 3: return the connectable ad accounts (NEVER the token). */
  async listPending(
    workspaceId: string,
    id: string,
  ): Promise<{ accounts: LinkedinAdAccountInfo[] }> {
    const row = await this.loadPendingRow(workspaceId, id);
    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;
    return { accounts: payload.accounts };
  }

  /** Step 4: provision the selected ad accounts, then delete the pending row. */
  async confirm(
    workspaceId: string,
    id: string,
    selected: string[],
  ): Promise<{ connected: number }> {
    const row = await this.loadPendingRow(workspaceId, id);
    const payload = JSON.parse(openSecret(row.payload)) as PendingPayload;

    const selectedSet = new Set(selected);
    const toConnect = payload.accounts.filter((a) => selectedSet.has(a.externalAdId));

    for (const acc of toConnect) {
      await this.adAccounts.connect(workspaceId, {
        provider: 'LINKEDIN',
        externalAdId: acc.externalAdId,
        accessToken: payload.token,
        displayName: acc.displayName,
        currency: acc.currency ?? undefined,
      });
    }

    await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } });
    return { connected: toConnect.length };
  }
}
