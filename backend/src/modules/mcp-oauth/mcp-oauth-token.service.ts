import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { OAuthHttpException } from './mcp-oauth.errors';
import { newSecret, pkceS256Challenge, secureEquals, sha256Hex } from './mcp-oauth.crypto';

/**
 * Short-lived by design. The access token is a bearer credential that travels
 * on every MCP call; an hour bounds the damage from one that leaks, and the
 * rotating refresh below makes renewal cheap.
 */
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Prefixes are functional, not cosmetic: `McpTokenVerifierService` routes on
 * the `mk_live_` prefix to choose between the API-key path and this one, so an
 * OAuth token must never be able to collide with that namespace.
 */
export const MCP_ACCESS_TOKEN_PREFIX = 'mcp_at_';
export const MCP_REFRESH_TOKEN_PREFIX = 'mcp_rt_';

/** Cap the parent-chain walk so a cycle (or a pathological chain) cannot spin. */
const MAX_CHAIN_DEPTH = 200;

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** What a valid access token resolves to (consumed by the MCP token verifier). */
export interface McpOAuthAccessGrant {
  tokenId: string;
  clientId: string;
  workspaceId: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: Date;
}

interface TokenRow {
  id: string;
  type: string;
  clientId: string;
  workspaceId: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: Date;
  revokedAt: Date | null;
  parentId: string | null;
}

/**
 * `/api/mcp-oauth/token` — the two grants we support.
 *
 * **Authorization codes are single-use, and enforced as such.** The code is
 * claimed with an `updateMany` gated on `consumedAt: null`, so two concurrent
 * exchanges cannot both mint tokens: exactly one update matches. A second
 * presentation — whether serial (already consumed on read) or a lost race
 * (`count === 0`) — is treated as a leak and revokes EVERYTHING derived from
 * that code. That is the point: on a replay we cannot tell whether the first
 * exchange was the legitimate client or the attacker, so neither keeps access.
 *
 * **Refresh tokens rotate.** Every refresh mints a new pair and revokes the one
 * presented, with `parentId` linking generation N+1 to N (and the first pair to
 * the authorization code itself, so the entire family hangs off one root).
 * Presenting an already-revoked refresh means someone is holding a stale copy —
 * again, unknowable which party — so the whole chain is revoked by walking up
 * to the root and back down through `parentId` (the index exists for exactly
 * this walk).
 */
@Injectable()
export class McpOAuthTokenService {
  private readonly logger = new Logger(McpOAuthTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async grant(body: Record<string, unknown>): Promise<OAuthTokenResponse> {
    switch (str(body.grant_type)) {
      case 'authorization_code':
        return this.exchangeCode(body);
      case 'refresh_token':
        return this.refresh(body);
      default:
        throw new OAuthHttpException(
          'unsupported_grant_type',
          'grant_type must be authorization_code or refresh_token',
        );
    }
  }

  /**
   * Resolve a raw access token to its grant, or null. Every call hits the
   * database, so revocation takes effect on the very next request — the stored
   * `expiresAt` is not a cache hint, it is the authority.
   */
  async verifyAccessToken(raw: string): Promise<McpOAuthAccessGrant | null> {
    const row = (await this.prisma.mcpOAuthToken.findFirst({
      where: { tokenHash: sha256Hex(raw), type: 'ACCESS' },
    })) as TokenRow | null;
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      tokenId: row.id,
      clientId: row.clientId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      scopes: row.scopes ?? [],
      resource: row.resource,
      expiresAt: row.expiresAt,
    };
  }

  private async exchangeCode(body: Record<string, unknown>): Promise<OAuthTokenResponse> {
    const raw = str(body.code);
    const verifier = str(body.code_verifier);
    if (!raw) throw new OAuthHttpException('invalid_request', 'code is required');
    if (!verifier) {
      throw new OAuthHttpException('invalid_request', 'code_verifier is required (PKCE)');
    }

    const code = await this.prisma.mcpOAuthCode.findUnique({ where: { codeHash: sha256Hex(raw) } });
    if (!code) throw new OAuthHttpException('invalid_grant', 'authorization code is not valid');

    if (code.consumedAt) {
      await this.onCodeReplay(code.id);
      throw new OAuthHttpException('invalid_grant', 'authorization code has already been used');
    }

    // Validate BEFORE consuming. A stolen code presented without the verifier
    // must not be able to burn the code and lock the legitimate client out.
    if (code.expiresAt.getTime() <= Date.now()) {
      throw new OAuthHttpException('invalid_grant', 'authorization code has expired');
    }
    if (code.clientId !== str(body.client_id)) {
      throw new OAuthHttpException('invalid_grant', 'authorization code was issued to another client');
    }
    if (code.redirectUri !== str(body.redirect_uri)) {
      throw new OAuthHttpException('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    // S256 only — the authorize endpoint refuses to store anything else, and
    // this second check keeps that true even if a row were written another way.
    if (code.codeChallengeMethod !== 'S256') {
      throw new OAuthHttpException('invalid_grant', 'unsupported code_challenge_method');
    }
    if (!secureEquals(pkceS256Challenge(verifier), code.codeChallenge)) {
      throw new OAuthHttpException('invalid_grant', 'code_verifier does not match the challenge');
    }

    // The claim IS the single-use guarantee: gated on `consumedAt: null`, so a
    // concurrent exchange that already claimed it leaves count === 0 here.
    const claimed = await this.prisma.mcpOAuthCode.updateMany({
      where: { id: code.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.onCodeReplay(code.id);
      throw new OAuthHttpException('invalid_grant', 'authorization code has already been used');
    }

    return this.issuePair({
      clientId: code.clientId,
      workspaceId: code.workspaceId,
      userId: code.userId,
      scopes: code.scopes ?? [],
      resource: code.resource,
      // Root the family at the code so replay defence is one downward walk.
      parentId: code.id,
    });
  }

  private async refresh(body: Record<string, unknown>): Promise<OAuthTokenResponse> {
    const raw = str(body.refresh_token);
    if (!raw) throw new OAuthHttpException('invalid_request', 'refresh_token is required');

    const row = (await this.prisma.mcpOAuthToken.findFirst({
      where: { tokenHash: sha256Hex(raw), type: 'REFRESH' },
    })) as TokenRow | null;
    if (!row) throw new OAuthHttpException('invalid_grant', 'refresh token is not valid');

    if (row.revokedAt) {
      // Reuse of a rotated refresh: either the client replayed a stale copy or
      // an attacker is using a stolen one. Indistinguishable — so the entire
      // chain goes, and both parties have to re-authorize.
      this.logger.warn(`revoked refresh token replayed (id=${row.id}) — revoking the chain`);
      await this.revokeFamily(row);
      throw new OAuthHttpException('invalid_grant', 'refresh token has been revoked');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new OAuthHttpException('invalid_grant', 'refresh token has expired');
    }
    if (row.clientId !== str(body.client_id)) {
      throw new OAuthHttpException('invalid_grant', 'refresh token was issued to another client');
    }

    // Rotation: the presented refresh dies here. Single use is what makes a
    // leaked refresh detectable at all — the next use of the stale copy
    // collides and trips the chain revocation above.
    await this.prisma.mcpOAuthToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });

    return this.issuePair({
      clientId: row.clientId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      scopes: row.scopes ?? [],
      resource: row.resource,
      parentId: row.id,
    });
  }

  private async issuePair(grant: {
    clientId: string;
    workspaceId: string;
    userId: string;
    scopes: string[];
    resource: string;
    parentId: string;
  }): Promise<OAuthTokenResponse> {
    const accessToken = newSecret(MCP_ACCESS_TOKEN_PREFIX);
    const refreshToken = newSecret(MCP_REFRESH_TOKEN_PREFIX);
    const now = Date.now();
    const common = {
      clientId: grant.clientId,
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      scopes: grant.scopes,
      // RFC 8707 — the audience rides on the token so the resource server can
      // refuse one minted for somewhere else.
      resource: grant.resource,
      parentId: grant.parentId,
    };

    await this.prisma.mcpOAuthToken.createMany({
      data: [
        {
          ...common,
          tokenHash: sha256Hex(accessToken),
          type: 'ACCESS',
          expiresAt: new Date(now + ACCESS_TTL_MS),
        },
        {
          ...common,
          tokenHash: sha256Hex(refreshToken),
          type: 'REFRESH',
          expiresAt: new Date(now + REFRESH_TTL_MS),
        },
      ],
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    };
  }

  /** A replayed authorization code: kill the code's whole descendant family. */
  private async onCodeReplay(codeId: string): Promise<void> {
    this.logger.warn(`authorization code replayed (id=${codeId}) — revoking derived tokens`);
    await this.revokeFrom(codeId);
  }

  /**
   * Revoke the entire family a token belongs to. Walks UP `parentId` first: the
   * presented token may be a late generation, and revoking only its descendants
   * would leave its ancestors' siblings (e.g. the access token minted alongside
   * an earlier refresh) alive.
   */
  private async revokeFamily(token: { id: string; parentId: string | null }): Promise<void> {
    let rootId = token.id;
    let parentId = token.parentId;
    const seen = new Set<string>([token.id]);

    for (let depth = 0; parentId && depth < MAX_CHAIN_DEPTH; depth += 1) {
      if (seen.has(parentId)) break;
      seen.add(parentId);
      const parent = (await this.prisma.mcpOAuthToken.findUnique({
        where: { id: parentId },
        select: { id: true, parentId: true },
      })) as { id: string; parentId: string | null } | null;
      if (!parent) {
        // No token row with that id — it is the authorization code the family
        // was rooted at, which is the true root of the walk.
        rootId = parentId;
        break;
      }
      rootId = parent.id;
      parentId = parent.parentId;
    }

    await this.revokeFrom(rootId);
  }

  /** Breadth-first over `parentId` (indexed), then one bulk revoke. */
  private async revokeFrom(rootId: string): Promise<void> {
    const ids = new Set<string>([rootId]);
    let frontier = [rootId];

    for (let depth = 0; frontier.length && depth < MAX_CHAIN_DEPTH; depth += 1) {
      const children = (await this.prisma.mcpOAuthToken.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true },
      })) as { id: string }[];
      frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
      frontier.forEach((id) => ids.add(id));
    }

    // `revokedAt: null` keeps the first revocation's timestamp — the moment the
    // breach was detected — rather than overwriting it on a later replay.
    await this.prisma.mcpOAuthToken.updateMany({
      where: { id: { in: [...ids] }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Reserved for callers that need the deployment's canonical audience. */
  protected baseUrl(): string | undefined {
    return this.config.get<string>('PUBLIC_BASE_URL');
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
