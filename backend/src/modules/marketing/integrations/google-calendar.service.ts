import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';

/**
 * Env-gated Google Calendar OAuth + token lifecycle.
 *
 * The whole feature is INERT unless BOTH:
 *  (a) the env OAuth client is set (GOOGLE_OAUTH_CLIENT_ID / _SECRET) — these
 *      are the OPERATOR's to supply, and
 *  (b) the secret-box is configured (MARKETING_SECRET_KEY) so access/refresh
 *      tokens can be sealed at rest.
 * When either is missing, admin mutations and the auth-url return a clean 400
 * ("Google Calendar not configured"); nothing crashes and no token is echoed.
 *
 * State storage for the OAuth round-trip is an in-memory Map (state → {ws,user,
 * expiresAt}). SINGLE-REPLICA only — the connect-start and the callback must
 * land on the same instance (mirrors SsoService; same scaling caveat).
 *
 * The Google APIs are reached via the SSRF-safe fetch with a timeout. Tokens
 * are sealed with the secret-box and masked out of every response.
 */

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the round-trip
// Refresh a little before the real expiry so a request mid-flight never 401s.
const REFRESH_SKEW_MS = 60 * 1000;

interface PendingConnect {
  workspaceId: string;
  marketingUserId: string;
  googleCalendarId: string;
  expiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface GoogleCalendarConnectionRow {
  id: string;
  workspaceId: string;
  marketingUserId: string;
  googleCalendarId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  syncToken: string | null;
  channelId: string | null;
  resourceId: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  /** Single-replica in-memory OAuth state store (see class doc). */
  private readonly pending = new Map<string, PendingConnect>();

  constructor(private readonly prisma: PrismaService) {}

  // ===================================================================== //
  //  Gating                                                               //
  // ===================================================================== //

  private envClientId(): string | undefined {
    return process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined;
  }
  private envClientSecret(): string | undefined {
    return process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined;
  }

  /**
   * True only when the OPERATOR has supplied the OAuth client AND the secret-box
   * is configured (so tokens can be sealed). Either missing ⇒ feature inert.
   */
  isConfigured(): boolean {
    return (
      !!this.envClientId() &&
      !!this.envClientSecret() &&
      isSecretBoxConfigured()
    );
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new BadRequestException('Google Calendar not configured');
    }
  }

  private redirectUri(): string {
    const base =
      process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
      process.env.MARKETING_PUBLIC_URL?.trim() ||
      'http://localhost:3000';
    // A bare path env wins as-is; otherwise join the fixed callback path.
    if (base.startsWith('http')) {
      return new URL(
        '/api/marketing/integrations/google-calendar/callback',
        base,
      ).toString();
    }
    return base;
  }

  // ===================================================================== //
  //  OAuth                                                                //
  // ===================================================================== //

  /**
   * Build the Google consent URL (offline access ⇒ a refresh_token; prompt
   * consent so the refresh_token is re-issued). Persists state→{ws,user} so the
   * callback can attribute the grant. Throws 400 when the feature is inert.
   */
  getAuthUrl(
    workspaceId: string,
    marketingUserId: string,
    googleCalendarId = 'primary',
  ): { url: string; state: string } {
    this.assertConfigured();
    const state = b64url(randomBytes(32));
    this.sweepExpired();
    this.pending.set(state, {
      workspaceId,
      marketingUserId,
      googleCalendarId: googleCalendarId || 'primary',
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const u = new URL(GOOGLE_AUTH_ENDPOINT);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.envClientId()!);
    u.searchParams.set('redirect_uri', this.redirectUri());
    u.searchParams.set('scope', CALENDAR_SCOPE);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return { url: u.toString(), state };
  }

  /**
   * Handle the Google redirect: validate state, exchange the code for tokens,
   * and upsert the (workspace,user,calendar) connection with SEALED tokens.
   * Returns the masked connection. Throws 401 on a bad/expired state.
   */
  async handleCallback(state: string, code: string) {
    this.assertConfigured();
    const ctx = this.consumeState(state);
    if (!ctx) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    const tokens = await this.exchangeCode(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      // No refresh_token ⇒ we can't keep the connection alive; force re-consent.
      throw new UnauthorizedException(
        'Google did not return a refresh token (re-consent with offline access)',
      );
    }
    const expiresAt = new Date(
      Date.now() + (tokens.expires_in ?? 3600) * 1000,
    );

    const existing = await this.prisma.googleCalendarConnection.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        marketingUserId: ctx.marketingUserId,
        googleCalendarId: ctx.googleCalendarId,
      },
      select: { id: true },
    });

    let row: GoogleCalendarConnectionRow;
    if (existing) {
      row = (await this.prisma.googleCalendarConnection.update({
        where: { id: existing.id },
        data: {
          accessToken: sealSecret(tokens.access_token),
          refreshToken: sealSecret(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          enabled: true,
          // A fresh grant invalidates the old incremental cursor.
          syncToken: null,
        },
      })) as GoogleCalendarConnectionRow;
    } else {
      row = (await this.prisma.googleCalendarConnection.create({
        data: {
          workspaceId: ctx.workspaceId,
          marketingUserId: ctx.marketingUserId,
          googleCalendarId: ctx.googleCalendarId,
          accessToken: sealSecret(tokens.access_token),
          refreshToken: sealSecret(tokens.refresh_token),
          tokenExpiresAt: expiresAt,
          enabled: true,
        },
      })) as GoogleCalendarConnectionRow;
    }
    return this.mask(row);
  }

  /**
   * Return a usable access token for a connection, refreshing via the sealed
   * refresh_token when the current one is expired (or within the skew window).
   * Persists the rotated access token + new expiry. Throws 401 on misconfig.
   */
  async getFreshAccessToken(
    connection: GoogleCalendarConnectionRow,
  ): Promise<string> {
    this.assertConfigured();
    const notExpired =
      connection.tokenExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now();
    if (notExpired) {
      return this.unsealOrThrow(connection.accessToken);
    }

    const refreshToken = this.unsealOrThrow(connection.refreshToken);
    const tokens = await this.refreshAccessToken(refreshToken);
    if (!tokens.access_token) {
      throw new UnauthorizedException('Google token refresh failed');
    }
    const expiresAt = new Date(
      Date.now() + (tokens.expires_in ?? 3600) * 1000,
    );
    await this.prisma.googleCalendarConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: sealSecret(tokens.access_token),
        tokenExpiresAt: expiresAt,
        // Google may rotate the refresh token; persist it when present.
        ...(tokens.refresh_token
          ? { refreshToken: sealSecret(tokens.refresh_token) }
          : {}),
      },
    });
    // Keep the in-memory copy coherent for the caller's current request.
    connection.tokenExpiresAt = expiresAt;
    return tokens.access_token;
  }

  // ===================================================================== //
  //  Admin CRUD (workspace-scoped, tokens masked)                         //
  // ===================================================================== //

  async list(workspaceId: string) {
    const rows = (await this.prisma.googleCalendarConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    })) as GoogleCalendarConnectionRow[];
    return rows.map((r) => this.mask(r));
  }

  /** Status for the admin UI: configured? + the workspace's connections. */
  async status(workspaceId: string) {
    return {
      configured: this.isConfigured(),
      connections: await this.list(workspaceId),
    };
  }

  async get(workspaceId: string, id: string) {
    return this.mask(await this.owned(workspaceId, id));
  }

  async disconnect(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    await this.prisma.googleCalendarConnection.delete({ where: { id } });
    return { id, disconnected: true };
  }

  // ===================================================================== //
  //  Internals                                                            //
  // ===================================================================== //

  async owned(
    workspaceId: string,
    id: string,
  ): Promise<GoogleCalendarConnectionRow> {
    const row = (await this.prisma.googleCalendarConnection.findFirst({
      where: { id, workspaceId },
    })) as GoogleCalendarConnectionRow | null;
    if (!row) throw new NotFoundException('Google Calendar connection not found');
    return row;
  }

  /** Strip sealed tokens; expose only safe metadata + boolean presence flags. */
  mask(row: GoogleCalendarConnectionRow) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      marketingUserId: row.marketingUserId,
      googleCalendarId: row.googleCalendarId,
      tokenSet: !!row.accessToken && !!row.refreshToken,
      tokenExpiresAt: row.tokenExpiresAt,
      syncEnabled: row.enabled,
      pushChannelActive: !!row.channelId,
      lastSyncToken: row.syncToken ? true : false,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private unsealOrThrow(sealed: string): string {
    try {
      return openSecret(sealed);
    } catch {
      // A rotated/misconfigured key must fail closed, never leak.
      throw new UnauthorizedException('Google Calendar connection misconfigured');
    }
  }

  private consumeState(state: string): PendingConnect | null {
    const ctx = this.pending.get(state);
    if (!ctx) return null;
    this.pending.delete(state); // single-use
    if (ctx.expiresAt < Date.now()) return null;
    return ctx;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (v.expiresAt < now) this.pending.delete(k);
    }
  }

  private async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.envClientId()!,
      client_secret: this.envClientSecret()!,
      redirect_uri: this.redirectUri(),
    });
    return this.tokenRequest(body, 'code exchange');
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.envClientId()!,
      client_secret: this.envClientSecret()!,
    });
    return this.tokenRequest(body, 'token refresh');
  }

  private async tokenRequest(
    body: URLSearchParams,
    label: string,
  ): Promise<GoogleTokenResponse> {
    let res: Response;
    try {
      res = await safeFetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        timeoutMs: 8000,
      });
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        this.logger.warn(`Google ${label} blocked: ${e.message}`);
      }
      throw new UnauthorizedException(`Google ${label} failed`);
    }
    if (!res.ok) {
      this.logger.warn(`Google ${label} failed: HTTP ${res.status}`);
      throw new UnauthorizedException(`Google ${label} failed`);
    }
    return (await res.json()) as GoogleTokenResponse;
  }
}

// ----------------------------- helpers ----------------------------------- //

function b64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
