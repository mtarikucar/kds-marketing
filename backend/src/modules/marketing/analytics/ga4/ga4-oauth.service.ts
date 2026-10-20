import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { googleOAuthClientId, googleOAuthClientSecret } from '../../../../common/util/google-oauth-env';
import { isSecretBoxConfigured, openSecret, sealSecret } from '../../../../common/crypto/secret-box.helper';
import { Ga4HttpClient } from './ga4-http.client';

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ACCOUNT_SUMMARIES = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries';
const CALLBACK_PATH = '/api/marketing/integrations/ga4/callback';
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
export const GA4_PROPERTY_ID = /^properties\/\d{1,20}$/;

/** Failure messages the public callback maps to a coarse `reason` for the panel. */
export const GA4_ERR = {
  notConfigured: 'GA4 is not configured',
  invalidState: 'Invalid or expired OAuth state',
  missingCode: 'Missing authorization code',
  noRefreshToken: 'Google did not return a refresh token (re-consent with offline access)',
  exchangeFailed: 'GA4 code exchange failed',
  refreshFailed: 'GA4 token refresh failed',
} as const;

interface StateClaims {
  workspaceId: string;
  marketingUserId: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface Ga4ConnectionRow {
  id: string;
  workspaceId: string;
  propertyId: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  lastSyncedAt: Date | null;
  enabled: boolean;
}

export interface Ga4Property {
  propertyId: string;
  displayName: string;
  account: string;
}

/**
 * GA4 over OAuth (contract §6.1): one property per workspace, read-only scope,
 * the operator's existing Google OAuth client (google-oauth-env). The same
 * stateless round-trip as Google Calendar: `state` is a sealed, self-contained
 * token, and both tokens are stored sealed. No Google SDK — raw fetch, like
 * every other Google integration in this codebase.
 */
@Injectable()
export class Ga4OAuthService {
  private readonly logger = new Logger(Ga4OAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: Ga4HttpClient,
  ) {}

  /** The Google client is set AND tokens can be sealed. */
  isConfigured(): boolean {
    return !!googleOAuthClientId() && !!googleOAuthClientSecret() && isSecretBoxConfigured();
  }

  connectUrl(workspaceId: string, marketingUserId: string): { url: string } {
    this.assertConfigured();
    const state = Buffer.from(
      sealSecret(JSON.stringify({ workspaceId, marketingUserId, expiresAt: Date.now() + STATE_TTL_MS } satisfies StateClaims)),
      'utf8',
    ).toString('base64url');
    const u = new URL(AUTH_ENDPOINT);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', googleOAuthClientId()!);
    u.searchParams.set('redirect_uri', this.redirectUri());
    u.searchParams.set('scope', GA4_SCOPE);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return { url: u.toString() };
  }

  /** Finish the round-trip: one connection per workspace, tokens sealed. */
  async handleCallback(state: string, code: string): Promise<{ workspaceId: string }> {
    this.assertConfigured();
    const claims = this.decodeState(state);
    if (!claims) throw new UnauthorizedException(GA4_ERR.invalidState);
    if (!code) throw new BadRequestException(GA4_ERR.missingCode);

    const tokens = await this.tokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: googleOAuthClientId()!,
        client_secret: googleOAuthClientSecret()!,
        redirect_uri: this.redirectUri(),
      }),
      GA4_ERR.exchangeFailed,
    );
    if (!tokens.access_token || !tokens.refresh_token) throw new UnauthorizedException(GA4_ERR.noRefreshToken);

    const fields = {
      marketingUserId: claims.marketingUserId,
      accessToken: sealSecret(tokens.access_token),
      refreshToken: sealSecret(tokens.refresh_token),
      tokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
      scopes: tokens.scope ?? null,
      enabled: true,
      lastError: null,
    };
    await this.prisma.ga4Connection.upsert({
      where: { workspaceId: claims.workspaceId },
      create: { workspaceId: claims.workspaceId, ...fields },
      update: fields,
    });
    return { workspaceId: claims.workspaceId };
  }

  /** The GA4 properties the connected Google account can read. */
  async listProperties(workspaceId: string): Promise<Ga4Property[]> {
    const conn = await this.connection(workspaceId);
    const token = await this.accessToken(conn);
    const out: Ga4Property[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = `${ACCOUNT_SUMMARIES}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await this.http.fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      if (!res.ok) throw new BadRequestException(`Google Analytics Admin API answered ${res.status}`);
      const body = (await res.json()) as {
        accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string }> }>;
        nextPageToken?: string;
      };
      for (const acc of body.accountSummaries ?? []) {
        for (const p of acc.propertySummaries ?? []) {
          if (p.property && GA4_PROPERTY_ID.test(p.property)) {
            out.push({ propertyId: p.property, displayName: p.displayName ?? p.property, account: acc.displayName ?? '' });
          }
        }
      }
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  }

  /**
   * Choose the property to read. Only one the account can actually see; a new
   * choice resets the sync so the next run backfills 35 days.
   */
  async selectProperty(workspaceId: string, propertyId: string) {
    if (!GA4_PROPERTY_ID.test(String(propertyId ?? ''))) {
      throw new BadRequestException('propertyId must look like "properties/123456789".');
    }
    const match = (await this.listProperties(workspaceId)).find((p) => p.propertyId === propertyId);
    if (!match) throw new BadRequestException('That property is not readable by the connected Google account.');
    await this.prisma.ga4Connection.update({
      where: { workspaceId },
      data: { propertyId, propertyName: match.displayName, lastSyncedAt: null, lastError: null, enabled: true },
    });
    return this.status(workspaceId);
  }

  /**
   * A usable access token: the stored one while it lives, otherwise a refresh
   * with the sealed refresh token (persisted). `forceRefresh` after a 401.
   */
  async accessToken(conn: Ga4ConnectionRow, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!opts.forceRefresh && conn.tokenExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
      return openSecret(conn.accessToken);
    }
    const tokens = await this.tokenRequest(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: openSecret(conn.refreshToken),
        client_id: googleOAuthClientId() ?? '',
        client_secret: googleOAuthClientSecret() ?? '',
      }),
      GA4_ERR.refreshFailed,
    );
    if (!tokens.access_token) throw new UnauthorizedException(GA4_ERR.refreshFailed);
    const tokenExpiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);
    await this.prisma.ga4Connection.update({
      where: { id: conn.id },
      data: {
        accessToken: sealSecret(tokens.access_token),
        tokenExpiresAt,
        ...(tokens.refresh_token ? { refreshToken: sealSecret(tokens.refresh_token) } : {}),
      },
    });
    conn.tokenExpiresAt = tokenExpiresAt;
    return tokens.access_token;
  }

  /** What the panel card shows. Never a token. */
  async status(workspaceId: string) {
    const conn = await this.prisma.ga4Connection.findUnique({ where: { workspaceId } });
    return {
      configured: this.isConfigured(),
      connected: !!conn,
      propertyId: conn?.propertyId ?? null,
      propertyName: conn?.propertyName ?? null,
      lastSyncedAt: conn?.lastSyncedAt ?? null,
      lastError: conn?.lastError ?? null,
      enabled: conn?.enabled ?? false,
    };
  }

  /** Removes the connection (and its tokens). The stats already pulled stay. */
  async disconnect(workspaceId: string) {
    const { count } = await this.prisma.ga4Connection.deleteMany({ where: { workspaceId } });
    return { disconnected: count > 0 };
  }

  /** Absolute panel URL for the browser redirect after consent (fixed paths only). */
  panelUrl(pathAndQuery: string): string {
    const base = process.env.MARKETING_PUBLIC_URL?.trim();
    return base && base.startsWith('http') ? new URL(pathAndQuery, base).toString() : pathAndQuery;
  }

  private async connection(workspaceId: string): Promise<Ga4ConnectionRow & { propertyName?: string | null }> {
    const conn = await this.prisma.ga4Connection.findUnique({ where: { workspaceId } });
    if (!conn) throw new NotFoundException('Google Analytics is not connected for this workspace.');
    return conn;
  }

  private redirectUri(): string {
    const explicit = process.env.GA4_OAUTH_REDIRECT_URI?.trim();
    if (explicit) return explicit;
    const base = process.env.MARKETING_PUBLIC_URL?.trim() || 'http://localhost:3000';
    return new URL(CALLBACK_PATH, base).toString();
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new BadRequestException(GA4_ERR.notConfigured);
  }

  private decodeState(state: string): StateClaims | null {
    if (!state) return null;
    try {
      const claims = JSON.parse(openSecret(Buffer.from(state, 'base64url').toString('utf8'))) as StateClaims;
      if (typeof claims?.workspaceId !== 'string' || typeof claims.marketingUserId !== 'string') return null;
      if (typeof claims.expiresAt !== 'number' || claims.expiresAt < Date.now()) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private async tokenRequest(body: URLSearchParams, failure: string): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.http.fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      });
    } catch {
      throw new UnauthorizedException(failure);
    }
    if (!res.ok) {
      // Google's OAuth error code (invalid_grant, redirect_uri_mismatch…) is not
      // a secret and is what makes the failure actionable.
      let code: string | null = null;
      try {
        const e = ((await res.json()) as { error?: string })?.error?.trim();
        code = e && /^[a-z_]+$/i.test(e) ? e : null;
      } catch {
        /* no body */
      }
      this.logger.warn(`${failure}: HTTP ${res.status}${code ? ` ${code}` : ''}`);
      throw new UnauthorizedException(code ? `${failure}: ${code}` : failure);
    }
    return (await res.json()) as TokenResponse;
  }
}
