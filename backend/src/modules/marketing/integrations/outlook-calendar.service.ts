import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';

/**
 * Env-gated Microsoft Outlook/O365 Calendar OAuth + token lifecycle (Epic 12).
 * A faithful mirror of GoogleCalendarService — same sealed-state round-trip,
 * sealed-at-rest tokens, refresh-skew lifecycle, and masked responses — over the
 * Microsoft identity platform (login.microsoftonline.com) + Graph.
 *
 * INERT unless BOTH the env OAuth client (MS_OAUTH_CLIENT_ID / _SECRET, the
 * OPERATOR's to supply from an Azure AD app) and the secret-box
 * (MARKETING_SECRET_KEY) are present. When either is missing, admin mutations
 * and the auth-url return a clean 400; nothing crashes and no token is echoed.
 */

const MS_AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
// offline_access ⇒ a refresh_token; Calendars.ReadWrite for 2-way sync.
const MS_SCOPES = 'offline_access openid profile Calendars.ReadWrite';
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

export const OUTLOOK_ERR = {
  notConfigured: 'Outlook Calendar not configured',
  invalidState: 'Invalid or expired OAuth state',
  missingCode: 'Missing authorization code',
  noRefreshToken: 'Microsoft did not return a refresh token (re-consent with offline access)',
  exchangeFailed: 'Microsoft code exchange failed',
} as const;

interface StateClaims {
  workspaceId: string;
  marketingUserId: string;
  outlookCalendarId: string;
  expiresAt: number;
}

interface MsTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface OutlookConnectionRow {
  id: string;
  workspaceId: string;
  marketingUserId: string;
  outlookCalendarId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  deltaToken: string | null;
  subscriptionId: string | null;
  clientState: string | null;
  subscriptionExpiration: Date | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class OutlookCalendarService {
  private readonly logger = new Logger(OutlookCalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  private envClientId(): string | undefined {
    return process.env.MS_OAUTH_CLIENT_ID?.trim() || undefined;
  }
  private envClientSecret(): string | undefined {
    return process.env.MS_OAUTH_CLIENT_SECRET?.trim() || undefined;
  }

  isConfigured(): boolean {
    return !!this.envClientId() && !!this.envClientSecret() && isSecretBoxConfigured();
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new BadRequestException(OUTLOOK_ERR.notConfigured);
  }

  panelUrl(pathAndQuery: string): string {
    const base = process.env.MARKETING_PUBLIC_URL?.trim();
    if (base && base.startsWith('http')) return new URL(pathAndQuery, base).toString();
    return pathAndQuery;
  }

  private redirectUri(): string {
    const base =
      process.env.MS_OAUTH_REDIRECT_URI?.trim() ||
      process.env.MARKETING_PUBLIC_URL?.trim() ||
      'http://localhost:3000';
    if (base.startsWith('http')) {
      return new URL('/api/marketing/integrations/outlook-calendar/callback', base).toString();
    }
    return base;
  }

  getAuthUrl(workspaceId: string, marketingUserId: string, outlookCalendarId = 'primary'): { url: string; state: string } {
    this.assertConfigured();
    const state = this.encodeState({
      workspaceId,
      marketingUserId,
      outlookCalendarId: outlookCalendarId || 'primary',
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    const u = new URL(MS_AUTH_ENDPOINT);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.envClientId()!);
    u.searchParams.set('redirect_uri', this.redirectUri());
    u.searchParams.set('scope', MS_SCOPES);
    u.searchParams.set('response_mode', 'query');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return { url: u.toString(), state };
  }

  async handleCallback(state: string, code: string) {
    this.assertConfigured();
    const ctx = this.decodeState(state);
    if (!ctx) throw new UnauthorizedException(OUTLOOK_ERR.invalidState);
    if (!code) throw new BadRequestException(OUTLOOK_ERR.missingCode);

    const tokens = await this.exchangeCode(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new UnauthorizedException(OUTLOOK_ERR.noRefreshToken);
    }
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);

    const existing = await this.prisma.outlookCalendarConnection.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        marketingUserId: ctx.marketingUserId,
        outlookCalendarId: ctx.outlookCalendarId,
      },
      select: { id: true },
    });

    let row: OutlookConnectionRow;
    if (existing) {
      row = (await this.prisma.outlookCalendarConnection.update({
        where: { id: existing.id },
        data: {
          accessToken: sealSecret(tokens.access_token),
          refreshToken: sealSecret(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          enabled: true,
          deltaToken: null, // a fresh grant invalidates the old delta cursor
        },
      })) as OutlookConnectionRow;
    } else {
      row = (await this.prisma.outlookCalendarConnection.create({
        data: {
          workspaceId: ctx.workspaceId,
          marketingUserId: ctx.marketingUserId,
          outlookCalendarId: ctx.outlookCalendarId,
          accessToken: sealSecret(tokens.access_token),
          refreshToken: sealSecret(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          enabled: true,
        },
      })) as OutlookConnectionRow;
    }
    return this.mask(row);
  }

  async getFreshAccessToken(connection: OutlookConnectionRow): Promise<string> {
    this.assertConfigured();
    const notExpired = connection.tokenExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now();
    if (notExpired) return this.unsealOrThrow(connection.accessToken);

    const refreshToken = this.unsealOrThrow(connection.refreshToken);
    const tokens = await this.refreshAccessToken(refreshToken);
    if (!tokens.access_token) throw new UnauthorizedException('Microsoft token refresh failed');
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);
    await this.prisma.outlookCalendarConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: sealSecret(tokens.access_token),
        tokenExpiresAt: expiresAt,
        ...(tokens.refresh_token ? { refreshToken: sealSecret(tokens.refresh_token) } : {}),
      },
    });
    connection.tokenExpiresAt = expiresAt;
    return tokens.access_token;
  }

  // ── Admin CRUD (workspace-scoped, tokens masked) ────────────────────────────

  async list(workspaceId: string) {
    const rows = (await this.prisma.outlookCalendarConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    })) as OutlookConnectionRow[];
    return rows.map((r) => this.mask(r));
  }

  async status(workspaceId: string) {
    return { configured: this.isConfigured(), connections: await this.list(workspaceId) };
  }

  async disconnect(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    await this.prisma.outlookCalendarConnection.delete({ where: { id } });
    return { id, disconnected: true };
  }

  async owned(workspaceId: string, id: string): Promise<OutlookConnectionRow> {
    const row = (await this.prisma.outlookCalendarConnection.findFirst({
      where: { id, workspaceId },
    })) as OutlookConnectionRow | null;
    if (!row) throw new NotFoundException('Outlook Calendar connection not found');
    return row;
  }

  mask(row: OutlookConnectionRow) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      marketingUserId: row.marketingUserId,
      outlookCalendarId: row.outlookCalendarId,
      tokenSet: !!row.accessToken && !!row.refreshToken,
      tokenExpiresAt: row.tokenExpiresAt,
      syncEnabled: row.enabled,
      subscriptionActive: !!row.subscriptionId,
      subscriptionExpiresAt: row.subscriptionExpiration,
      hasDeltaCursor: row.deltaToken ? true : false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private unsealOrThrow(sealed: string): string {
    try {
      return openSecret(sealed);
    } catch {
      throw new UnauthorizedException('Outlook Calendar connection misconfigured');
    }
  }

  private encodeState(claims: StateClaims): string {
    return b64url(Buffer.from(sealSecret(JSON.stringify(claims)), 'utf8'));
  }

  private decodeState(state: string): StateClaims | null {
    if (!state) return null;
    try {
      const json = openSecret(b64urlDecode(state).toString('utf8'));
      const claims = JSON.parse(json) as StateClaims;
      if (
        !claims ||
        typeof claims.workspaceId !== 'string' ||
        typeof claims.marketingUserId !== 'string' ||
        typeof claims.expiresAt !== 'number'
      ) {
        return null;
      }
      if (claims.expiresAt < Date.now()) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private async exchangeCode(code: string): Promise<MsTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.envClientId()!,
      client_secret: this.envClientSecret()!,
      redirect_uri: this.redirectUri(),
      scope: MS_SCOPES,
    });
    return this.tokenRequest(body, 'code exchange');
  }

  private async refreshAccessToken(refreshToken: string): Promise<MsTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.envClientId()!,
      client_secret: this.envClientSecret()!,
      scope: MS_SCOPES,
    });
    return this.tokenRequest(body, 'token refresh');
  }

  private async tokenRequest(body: URLSearchParams, label: string): Promise<MsTokenResponse> {
    let res: Response;
    try {
      res = await safeFetch(MS_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        timeoutMs: 8000,
      });
    } catch (e) {
      if (e instanceof SsrfBlockedError) this.logger.warn(`Microsoft ${label} blocked: ${e.message}`);
      throw new UnauthorizedException(`Microsoft ${label} failed`);
    }
    if (!res.ok) {
      const code = await readMsError(res);
      this.logger.warn(`Microsoft ${label} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
      throw new UnauthorizedException(code ? `Microsoft ${label} failed: ${code}` : `Microsoft ${label} failed`);
    }
    return (await res.json()) as MsTokenResponse;
  }
}

/** Microsoft's OAuth error code (clean [a-z_] token only — URL/log-safe). */
async function readMsError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: string };
    const code = body?.error?.trim();
    return code && /^[a-z_]+$/i.test(code) ? code : null;
  } catch {
    return null;
  }
}

function b64url(input: Buffer): string {
  return input.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
