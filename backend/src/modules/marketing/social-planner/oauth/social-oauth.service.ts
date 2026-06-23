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

  constructor(private readonly prisma: PrismaService) {}

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
    // PKCE networks (X): mint a verifier/challenge, SEAL the verifier into the
    // signed state (so the callback can recover it without a server session),
    // and put only the S256 challenge on the authorize URL.
    if (usesPkce(n)) {
      const { verifier, challenge } = generatePkce();
      const state = signState({ workspaceId, network: n, cv: sealSecret(verifier) });
      return { authorizeUrl: buildAuthorizeUrl(n, state, challenge) };
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

  /** Turn the chosen assets into sealed SocialAccount rows; delete the pending row. */
  async confirm(workspaceId: string, id: string, selected: string[]) {
    const row = await this.loadPending(workspaceId, id);
    const data = JSON.parse(openSecret(row.payload)) as SealedPayload;
    const chosen = (data.assets ?? []).filter((a) => selected.includes(a.externalId));
    if (chosen.length === 0) {
      throw new BadRequestException('Select at least one account to connect');
    }
    const tokenExpiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    const sealedRefresh = data.refreshToken ? sealSecret(data.refreshToken) : null;

    for (const asset of chosen) {
      const sealedToken = sealSecret(asset.token ?? data.token);
      const fields = {
        displayName: asset.displayName,
        accessToken: sealedToken,
        tokenExpiresAt,
        refreshToken: sealedRefresh,
        accountType: asset.accountType,
        connectedVia: 'OAUTH',
        enabled: true,
        lastError: null,
      };
      await this.prisma.socialAccount.upsert({
        where: {
          workspaceId_network_externalId: {
            workspaceId,
            network: row.network,
            externalId: asset.externalId,
          },
        },
        create: {
          workspaceId,
          network: row.network,
          externalId: asset.externalId,
          ...fields,
        },
        update: fields,
      });
    }
    await this.prisma.pendingSocialConnection.delete({ where: { id: row.id } });
    return { connected: chosen.length };
  }
}
