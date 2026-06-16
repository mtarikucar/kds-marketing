import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
  type JsonWebKey as CryptoJsonWebKey,
} from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingAuthService } from './marketing-auth.service';
import {
  sealSecret,
  openSecret,
  isSecretBoxConfigured,
} from '../../../common/crypto/secret-box.helper';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';

/**
 * Epic G — env-gated enterprise SSO via OIDC (authorization-code + PKCE S256).
 *
 * The whole feature is INERT unless (a) the secret-box is configured
 * (MARKETING_SECRET_KEY) — clientSecret is sealed at rest — AND (b) the
 * workspace has an `enabled` SsoConnection. When either is missing the start
 * endpoint returns a clean 400 ("SSO not configured"); nothing crashes.
 *
 * Token logic is NOT duplicated here: once an ID token is verified and a
 * MarketingUser is matched/provisioned, we hand off to
 * MarketingAuthService.issueSession() which mints the normal marketing pair.
 *
 * State storage: in-memory Map (state → {workspaceId, nonce, codeVerifier,
 * expiresAt}). This is SINGLE-REPLICA only — the start and callback must land
 * on the same instance. For a multi-replica deployment, move this to a shared
 * short-lived store (Redis / a small table); the surface is one Map.
 */

interface PendingAuth {
  workspaceId: string;
  connectionId: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the round-trip
const DEFAULT_NEW_USER_ROLE = 'REP';

export interface SsoConnectionInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  allowedDomains?: string[];
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  /** Single-replica in-memory state store (see class doc). */
  private readonly pending = new Map<string, PendingAuth>();
  /** Tiny discovery cache so each callback doesn't re-discover. */
  private readonly discoveryCache = new Map<
    string,
    { doc: OidcDiscovery; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: MarketingAuthService,
  ) {}

  // ===================================================================== //
  //  Public: gating helper                                                //
  // ===================================================================== //

  /** True only when the secret-box is configured (clientSecret can be sealed). */
  isConfigured(): boolean {
    return isSecretBoxConfigured();
  }

  /**
   * Resolve a workspace by slug OR id for the PUBLIC start endpoint. Returns
   * the workspace id, or null when no ACTIVE workspace matches — the caller
   * turns that into a clean 404 (no enumeration of which workspaces exist).
   */
  async resolveWorkspaceId(slugOrId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findFirst({
      where: { OR: [{ id: slugOrId }, { slug: slugOrId }], status: 'ACTIVE' },
      select: { id: true },
    });
    return ws?.id ?? null;
  }

  // ===================================================================== //
  //  Public: OIDC authorization-code flow                                 //
  // ===================================================================== //

  /**
   * Build the IdP authorize URL for a workspace's enabled connection.
   * Persists state→{nonce, codeVerifier} so the callback can validate.
   * Throws BadRequestException("SSO not configured") when inert.
   */
  async getAuthorizationUrl(
    workspaceId: string,
  ): Promise<{ url: string; state: string }> {
    if (!this.isConfigured()) {
      throw new BadRequestException('SSO not configured');
    }
    const conn = await this.prisma.ssoConnection.findFirst({
      where: { workspaceId, enabled: true },
    });
    if (!conn) {
      throw new BadRequestException('SSO not configured');
    }

    const discovery = await this.discover(conn.issuer);

    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const codeVerifier = b64url(randomBytes(32));
    const codeChallenge = b64url(
      createHash('sha256').update(codeVerifier).digest(),
    );

    this.sweepExpired();
    this.pending.set(state, {
      workspaceId,
      connectionId: conn.id,
      nonce,
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const u = new URL(discovery.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', conn.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri());
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');

    return { url: u.toString(), state };
  }

  /**
   * Handle the IdP redirect: validate state, exchange the code, verify the ID
   * token (iss/aud/exp/nonce + RS256 signature via JWKS), JIT-match/provision a
   * MarketingUser in the connection's workspace, and mint a marketing session.
   */
  async handleCallback(state: string, code: string) {
    const ctx = this.consumeState(state);
    if (!ctx) {
      throw new UnauthorizedException('Invalid or expired SSO state');
    }

    const conn = await this.prisma.ssoConnection.findFirst({
      where: { id: ctx.connectionId, workspaceId: ctx.workspaceId, enabled: true },
    });
    if (!conn) {
      throw new UnauthorizedException('SSO connection unavailable');
    }

    const discovery = await this.discover(conn.issuer);
    const clientSecret = this.unsealOrThrow(conn.clientSecret);

    const idToken = await this.exchangeCode(
      discovery.token_endpoint,
      code,
      conn.clientId,
      clientSecret,
      ctx.codeVerifier,
    );

    const claims = await this.verifyIdToken(
      idToken,
      discovery.jwks_uri,
      conn.issuer,
      conn.clientId,
      ctx.nonce,
    );

    const email = String(claims.email ?? '').toLowerCase().trim();
    if (!email || !email.includes('@')) {
      throw new UnauthorizedException('ID token has no usable email');
    }
    // Honour the IdP's verification signal when present.
    if (claims.email_verified === false) {
      throw new UnauthorizedException('Email is not verified at the IdP');
    }
    this.assertDomainAllowed(email, conn.allowedDomains);

    const user = await this.matchOrProvision(ctx.workspaceId, email, claims);
    return this.authService.issueSession(user);
  }

  // ===================================================================== //
  //  Public: admin CRUD (workspace-scoped, secret masked)                 //
  // ===================================================================== //

  async list(workspaceId: string) {
    const rows = await this.prisma.ssoConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mask(r));
  }

  async get(workspaceId: string, id: string) {
    return this.mask(await this.owned(workspaceId, id));
  }

  async create(workspaceId: string, dto: SsoConnectionInput) {
    this.assertSecretBox();
    const row = await this.prisma.ssoConnection.create({
      data: {
        workspaceId,
        provider: 'OIDC',
        issuer: normalizeIssuer(dto.issuer),
        clientId: dto.clientId,
        clientSecret: sealSecret(dto.clientSecret),
        enabled: dto.enabled ?? false,
        allowedDomains: normalizeDomains(dto.allowedDomains),
      },
    });
    return this.mask(row);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: Partial<SsoConnectionInput>,
  ) {
    await this.owned(workspaceId, id);
    if (dto.clientSecret !== undefined) this.assertSecretBox();
    const row = await this.prisma.ssoConnection.update({
      where: { id },
      data: {
        ...(dto.issuer !== undefined && { issuer: normalizeIssuer(dto.issuer) }),
        ...(dto.clientId !== undefined && { clientId: dto.clientId }),
        ...(dto.clientSecret !== undefined && {
          clientSecret: sealSecret(dto.clientSecret),
        }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.allowedDomains !== undefined && {
          allowedDomains: normalizeDomains(dto.allowedDomains),
        }),
      },
    });
    return this.mask(row);
  }

  async remove(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    await this.prisma.ssoConnection.delete({ where: { id } });
    return { id };
  }

  // ===================================================================== //
  //  Internals                                                            //
  // ===================================================================== //

  private async owned(workspaceId: string, id: string) {
    const row = await this.prisma.ssoConnection.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException('SSO connection not found');
    return row;
  }

  /** Strip the sealed secret; expose only whether one is set. */
  private mask(row: {
    id: string;
    workspaceId: string;
    provider: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    enabled: boolean;
    allowedDomains: string[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecretSet: !!row.clientSecret,
      enabled: row.enabled,
      allowedDomains: row.allowedDomains,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private assertSecretBox() {
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException(
        'SSO not configured: MARKETING_SECRET_KEY is required to seal the client secret',
      );
    }
  }

  private unsealOrThrow(sealed: string): string {
    try {
      return openSecret(sealed);
    } catch {
      // A misconfigured/rotated key must fail closed, not leak.
      throw new UnauthorizedException('SSO connection is misconfigured');
    }
  }

  private redirectUri(): string {
    const base =
      process.env.SSO_REDIRECT_URI ??
      process.env.MARKETING_PUBLIC_URL ??
      'http://localhost:3000';
    // Always the fixed callback path.
    return new URL('/api/marketing/auth/sso/callback', base).toString();
  }

  private assertDomainAllowed(email: string, allowed: string[]) {
    if (!allowed || allowed.length === 0) return;
    const domain = email.split('@')[1] ?? '';
    if (!allowed.map((d) => d.toLowerCase()).includes(domain)) {
      throw new UnauthorizedException(
        'Email domain is not permitted for this SSO connection',
      );
    }
  }

  private consumeState(state: string): PendingAuth | null {
    const ctx = this.pending.get(state);
    if (!ctx) return null;
    // Single-use: delete regardless of expiry so a replayed state is dead.
    this.pending.delete(state);
    if (ctx.expiresAt < Date.now()) return null;
    return ctx;
  }

  private sweepExpired() {
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (v.expiresAt < now) this.pending.delete(k);
    }
  }

  // ---- OIDC plumbing ---------------------------------------------------- //

  private async discover(issuer: string): Promise<OidcDiscovery> {
    const key = normalizeIssuer(issuer);
    const cached = this.discoveryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.doc;

    const url = `${key}/.well-known/openid-configuration`;
    const res = await this.outbound(url, { method: 'GET' });
    if (!res.ok) {
      throw new UnauthorizedException('IdP discovery failed');
    }
    const doc = (await res.json()) as Partial<OidcDiscovery>;
    if (!doc.token_endpoint || !doc.jwks_uri) {
      throw new UnauthorizedException('IdP discovery document is incomplete');
    }
    const full: OidcDiscovery = {
      authorization_endpoint: doc.authorization_endpoint ?? `${key}/authorize`,
      token_endpoint: doc.token_endpoint,
      jwks_uri: doc.jwks_uri,
    };
    this.discoveryCache.set(key, {
      doc: full,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return full;
  }

  private async exchangeCode(
    tokenEndpoint: string,
    code: string,
    clientId: string,
    clientSecret: string,
    codeVerifier: string,
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: codeVerifier,
    });

    const res = await this.outbound(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      this.logger.warn(`SSO token exchange failed: HTTP ${res.status}`);
      throw new UnauthorizedException('SSO token exchange failed');
    }
    const json = (await res.json()) as { id_token?: string };
    if (!json.id_token) {
      throw new UnauthorizedException('IdP returned no ID token');
    }
    return json.id_token;
  }

  /**
   * Verify an RS256 ID token using node crypto + the IdP JWKS:
   *  - reject any alg other than RS256 (defeats alg=none / HS confusion)
   *  - signature over the signing input with the JWKS key (by kid)
   *  - iss == issuer, aud == clientId, exp not past, nonce matches
   */
  private async verifyIdToken(
    idToken: string,
    jwksUri: string,
    issuer: string,
    clientId: string,
    expectedNonce: string,
  ): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Malformed ID token');
    }
    const [headerB64, payloadB64, sigB64] = parts;

    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(fromB64url(headerB64).toString('utf8'));
      claims = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    } catch {
      throw new UnauthorizedException('Unparseable ID token');
    }

    if (header.alg !== 'RS256') {
      throw new UnauthorizedException('Unsupported ID token algorithm');
    }

    const jwk = await this.resolveJwk(jwksUri, header.kid);
    const publicKey = createPublicKey({
      key: jwk as unknown as CryptoJsonWebKey,
      format: 'jwk',
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const valid = verifier.verify(publicKey, fromB64url(sigB64));
    if (!valid) {
      throw new UnauthorizedException('ID token signature is invalid');
    }

    // Claim checks (after signature so we never trust unsigned values).
    if (claims.iss !== normalizeIssuer(issuer) && claims.iss !== issuer) {
      throw new UnauthorizedException('ID token issuer mismatch');
    }
    if (!audMatches(claims.aud, clientId)) {
      throw new UnauthorizedException('ID token audience mismatch');
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) {
      throw new UnauthorizedException('ID token is expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) {
      throw new UnauthorizedException('ID token not yet valid');
    }
    if (
      typeof claims.nonce !== 'string' ||
      !constantTimeEqual(claims.nonce, expectedNonce)
    ) {
      throw new UnauthorizedException('ID token nonce mismatch');
    }
    return claims;
  }

  private async resolveJwk(jwksUri: string, kid?: string): Promise<Jwk> {
    const res = await this.outbound(jwksUri, { method: 'GET' });
    if (!res.ok) {
      throw new UnauthorizedException('Failed to fetch IdP JWKS');
    }
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = body.keys ?? [];
    const rsaKeys = keys.filter((k) => k.kty === 'RSA');
    const match = kid
      ? rsaKeys.find((k) => k.kid === kid)
      : rsaKeys[0];
    const chosen = match ?? rsaKeys[0];
    if (!chosen) {
      throw new UnauthorizedException('No matching JWKS key for the ID token');
    }
    return chosen;
  }

  private async matchOrProvision(
    workspaceId: string,
    email: string,
    claims: Record<string, unknown>,
  ) {
    const existing = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, email },
    });
    if (existing) {
      if (existing.role === 'SYSTEM' || existing.status !== 'ACTIVE') {
        throw new UnauthorizedException('Account cannot sign in via SSO');
      }
      return existing;
    }
    // JIT provision. No password is usable: store a random sealed-strength
    // sentinel so the password login path can never authenticate this row.
    const randomPassword = b64url(randomBytes(48));
    return this.prisma.marketingUser.create({
      data: {
        workspaceId,
        email,
        password: randomPassword,
        firstName: strClaim(claims.given_name) || email.split('@')[0],
        lastName: strClaim(claims.family_name),
        role: DEFAULT_NEW_USER_ROLE,
      },
    });
  }

  /** SSRF-safe outbound IdP call with a timeout; never reaches internal hosts. */
  private async outbound(url: string, init: RequestInit): Promise<Response> {
    try {
      return await safeFetch(url, { ...init, timeoutMs: 8000 });
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        this.logger.warn(`SSO outbound blocked: ${e.message}`);
        throw new UnauthorizedException('IdP endpoint is not reachable');
      }
      throw new UnauthorizedException('IdP request failed');
    }
  }
}

// ----------------------------- helpers ----------------------------------- //

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Trim a trailing slash so `${issuer}/...` joins are stable. */
function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

function normalizeDomains(domains?: string[]): string[] {
  if (!domains) return [];
  return Array.from(
    new Set(domains.map((d) => d.toLowerCase().trim()).filter(Boolean)),
  );
}

function strClaim(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** OIDC `aud` may be a string or an array; clientId must be present. */
function audMatches(aud: unknown, clientId: string): boolean {
  if (typeof aud === 'string') return aud === clientId;
  if (Array.isArray(aud)) return aud.includes(clientId);
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
