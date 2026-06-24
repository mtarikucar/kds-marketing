import { Injectable, Logger, BadRequestException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { safeFetch } from '../../../common/util/safe-fetch';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { googleOAuthClientId, googleOAuthClientSecret, isGoogleOAuthConfigured } from '../../../common/util/google-oauth-env';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const FB_VER = 'v19.0';
const STATE_TTL_MS = 15 * 60 * 1000;

interface ReviewOAuthState { workspaceId: string; sourceId: string; type: 'GOOGLE' | 'FACEBOOK'; expiresAt: number }

/**
 * OAuth connect for review SOURCES (audit A9 + E4). Until this, a source needed
 * an out-of-band pasted token that expired with no re-auth path. This adds a
 * proper Connect-Google/Facebook flow: a consent URL + a callback that exchanges
 * the code for a long-lived/refresh token, SEALED onto the ReviewSource. Inert
 * (400) until the provider OAuth client env + secret-box are configured.
 */
@Injectable()
export class ReviewOAuthService {
  private readonly logger = new Logger(ReviewOAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  isConfigured(type: string): boolean {
    if (!isSecretBoxConfigured()) return false;
    return type === 'GOOGLE'
      ? isGoogleOAuthConfigured()
      : !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
  }

  /** The consent URL for a source, with a sealed self-contained state. */
  async connectUrl(workspaceId: string, sourceId: string): Promise<{ url: string }> {
    const source = await this.prisma.reviewSource.findFirst({ where: { id: sourceId, workspaceId }, select: { type: true } });
    if (!source) throw new NotFoundException('Review source not found');
    const type = source.type === 'FACEBOOK' ? 'FACEBOOK' : 'GOOGLE';
    if (!this.isConfigured(type)) throw new BadRequestException(`${type} review connect is not enabled`);
    const state = sealSecret(JSON.stringify({ workspaceId, sourceId, type, expiresAt: Date.now() + STATE_TTL_MS } as ReviewOAuthState));
    if (type === 'GOOGLE') {
      const u = new URL(GOOGLE_AUTH);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', googleOAuthClientId()!);
      u.searchParams.set('redirect_uri', this.redirectUri());
      u.searchParams.set('scope', GBP_SCOPE);
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('state', state);
      return { url: u.toString() };
    }
    const u = new URL(`https://www.facebook.com/${FB_VER}/dialog/oauth`);
    u.searchParams.set('client_id', process.env.META_APP_ID!);
    u.searchParams.set('redirect_uri', this.redirectUri());
    u.searchParams.set('scope', 'pages_show_list,pages_read_engagement,pages_read_user_content');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', state);
    return { url: u.toString() };
  }

  /** Provider redirect: validate state, exchange code, seal the token onto the source. */
  async handleCallback(state: string, code: string): Promise<{ workspaceId: string; sourceId: string }> {
    const ctx = this.decodeState(state);
    if (!ctx) throw new UnauthorizedException('Invalid or expired OAuth state');
    if (!code) throw new BadRequestException('Missing authorization code');
    const token = ctx.type === 'GOOGLE' ? await this.exchangeGoogle(code) : await this.exchangeFacebook(code);
    await this.prisma.reviewSource.updateMany({
      where: { id: ctx.sourceId, workspaceId: ctx.workspaceId },
      data: { accessToken: sealSecret(token), syncStatus: 'ACTIVE', lastError: null },
    });
    return { workspaceId: ctx.workspaceId, sourceId: ctx.sourceId };
  }

  private async exchangeGoogle(code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code,
      client_id: googleOAuthClientId()!, client_secret: googleOAuthClientSecret()!,
      redirect_uri: this.redirectUri(),
    });
    const res = await safeFetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), timeoutMs: 10_000 } as any);
    const json = (await res.json().catch(() => null)) as { refresh_token?: string; access_token?: string } | null;
    const tok = json?.refresh_token || json?.access_token;
    if (!res.ok || !tok) throw new BadRequestException('Google token exchange failed');
    return tok; // prefer the refresh_token (offline access)
  }

  private async exchangeFacebook(code: string): Promise<string> {
    // short-lived user token …
    const ex = new URL(`https://graph.facebook.com/${FB_VER}/oauth/access_token`);
    ex.searchParams.set('client_id', process.env.META_APP_ID!);
    ex.searchParams.set('client_secret', process.env.META_APP_SECRET!);
    ex.searchParams.set('redirect_uri', this.redirectUri());
    ex.searchParams.set('code', code);
    const r1 = await safeFetch(ex.toString(), { timeoutMs: 10_000 });
    const j1 = (await r1.json().catch(() => null)) as { access_token?: string } | null;
    if (!r1.ok || !j1?.access_token) throw new BadRequestException('Facebook token exchange failed');
    // … exchanged for a long-lived token so it doesn't expire in ~1h.
    const ll = new URL(`https://graph.facebook.com/${FB_VER}/oauth/access_token`);
    ll.searchParams.set('grant_type', 'fb_exchange_token');
    ll.searchParams.set('client_id', process.env.META_APP_ID!);
    ll.searchParams.set('client_secret', process.env.META_APP_SECRET!);
    ll.searchParams.set('fb_exchange_token', j1.access_token);
    const r2 = await safeFetch(ll.toString(), { timeoutMs: 10_000 });
    const j2 = (await r2.json().catch(() => null)) as { access_token?: string } | null;
    return j2?.access_token || j1.access_token; // long-lived if available, else the short-lived
  }

  private redirectUri(): string {
    const base = process.env.MARKETING_PUBLIC_URL?.trim() || process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:3000';
    return base.startsWith('http') ? new URL('/api/public/reviews/oauth/callback', base).toString() : base;
  }

  private decodeState(state: string): ReviewOAuthState | null {
    if (!isSecretBoxConfigured()) return null;
    try {
      const ctx = JSON.parse(openSecret(state)) as ReviewOAuthState;
      if (!ctx?.workspaceId || !ctx?.sourceId || ctx.expiresAt < Date.now()) return null;
      return ctx;
    } catch {
      return null;
    }
  }
}
