import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from '../marketing/services/membership.service';
import { RolesService } from '../marketing/roles/roles.service';
import { MCP_ALL_SCOPES } from '../marketing/mcp/mcp-scopes';
import { CimdClientService, CimdError, ResolvedCimdClient } from './cimd-client.service';
import { isCanonicalMcpResource, mcpOAuthIssuer } from './mcp-oauth.config';
import { newSecret, sha256Hex } from './mcp-oauth.crypto';
import { OAuthHttpException } from './mcp-oauth.errors';

/**
 * Authorization codes are redeemed within seconds of being issued by a client
 * that is already waiting on the redirect. OAuth 2.1 §4.1.1 caps the lifetime
 * at 10 minutes; there is no reason to be more generous, and every extra minute
 * is extra window for a leaked code.
 */
const CODE_TTL_MS = 5 * 60 * 1000;

const SCOPE_VOCABULARY: ReadonlySet<string> = new Set(MCP_ALL_SCOPES);

/** The authorization request, after every check has passed. */
export interface ValidatedAuthorizeRequest {
  client: ResolvedCimdClient;
  clientId: string;
  redirectUri: string;
  requestedScopes: string[];
  /** The RFC 8707 audience — always our canonical MCP URI by the time it is here. */
  resource: string;
  codeChallenge: string;
  state: string | null;
}

export interface ConsentWorkspace {
  workspaceId: string;
  workspaceName: string;
  role: string;
  /** The requested scopes this caller can actually grant HERE (role-capped). */
  grantableScopes: string[];
}

export interface ConsentData {
  client: { clientId: string; clientName: string | null; logoUri: string | null };
  requestedScopes: string[];
  resource: string;
  redirectUri: string;
  state: string | null;
  workspaces: ConsentWorkspace[];
}

/**
 * The `/authorize` half of the authorization server: validate the request,
 * describe it for the consent screen, and — only after a signed-in human says
 * yes — mint the single-use authorization code.
 *
 * Two properties are load-bearing here:
 *
 *  1. **Nothing is trusted from the request.** `client_id` is resolved through
 *     CIMD, `redirect_uri` must be one the resolved document declares, and
 *     `resource` must name our own MCP endpoint. All three are re-checked on
 *     the consent POST — the GET's verdict is never carried in a cookie or a
 *     signed blob a caller could replay with different parameters.
 *  2. **Consent cannot manufacture authority.** The granted scopes are capped
 *     twice: by what the client asked for, and by what the consenting user
 *     actually holds in the chosen workspace (resolved from their ACTIVE
 *     membership through the same RolesService the HTTP guards use). A REP
 *     cannot consent themselves into `campaigns.send`, and nobody can consent
 *     for a workspace they are not a member of.
 */
@Injectable()
export class McpOAuthCodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cimd: CimdClientService,
    private readonly memberships: MembershipService,
    private readonly roles: RolesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Validate an authorization request. Throws {@link OAuthHttpException} — the
   * caller renders it as an error response rather than redirecting, because at
   * this point `redirect_uri` has not been proven to belong to the client and
   * bouncing an error to it would be an open redirect.
   */
  async validate(raw: Record<string, unknown>): Promise<ValidatedAuthorizeRequest> {
    const responseType = str(raw.response_type);
    if (responseType !== 'code') {
      throw new OAuthHttpException(
        'unsupported_response_type',
        'only response_type=code is supported',
      );
    }

    // PKCE first: it is mandatory in OAuth 2.1 for every client, public or not,
    // and `plain` is never accepted (it puts the verifier in the very request an
    // attacker would have had to intercept to steal the code).
    const codeChallenge = str(raw.code_challenge);
    if (!codeChallenge) {
      throw new OAuthHttpException('invalid_request', 'code_challenge is required (PKCE)');
    }
    if (str(raw.code_challenge_method) !== 'S256') {
      // Note RFC 7636 §4.3 defaults an ABSENT method to `plain`; inheriting that
      // default silently would disable PKCE for any client that simply omits it.
      throw new OAuthHttpException(
        'invalid_request',
        'code_challenge_method must be S256',
      );
    }

    const clientId = str(raw.client_id);
    if (!clientId) {
      throw new OAuthHttpException('invalid_request', 'client_id is required');
    }
    // Resolving through CIMD is what makes `redirect_uris` authoritative: the
    // list comes from a document the client itself published at that URL.
    //
    // A CimdError is a BadRequestException, so leaving it alone would still be
    // a 400 — but with Nest's default body, whose `error` is the HTTP reason
    // phrase ("Bad Request"), not an RFC 6749 code. An OAuth client reads
    // `error` to decide what to do next and would see garbage. Re-render it
    // with the code the CIMD layer already determined.
    let client: ResolvedCimdClient;
    try {
      client = await this.cimd.resolveClient(clientId);
    } catch (err) {
      if (err instanceof CimdError) {
        throw new OAuthHttpException(err.oauthError, cimdMessage(err));
      }
      throw err;
    }

    const redirectUri = str(raw.redirect_uri);
    // Exact string match, deliberately. Prefix matching is the classic redirect
    // hijack (`https://client.example/cb` also matching `…/cb.evil.com`), and
    // normalising would let two spellings of one entry drift apart.
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      throw new OAuthHttpException(
        'invalid_request',
        'redirect_uri is not registered for this client',
      );
    }

    const resource = str(raw.resource);
    if (!isCanonicalMcpResource(resource, this.baseUrl())) {
      throw new OAuthHttpException(
        'invalid_target',
        'resource must be this server’s canonical MCP endpoint',
      );
    }

    const requestedScopes = this.parseScopes(raw.scope);

    return {
      client,
      clientId,
      redirectUri,
      requestedScopes,
      resource: resource!,
      codeChallenge,
      state: str(raw.state) ?? null,
    };
  }

  /**
   * Everything the consent screen renders. Deliberately read-only: a GET that
   * minted a code would hand one out to anything that could make the browser
   * navigate (a prefetch, an <img>, a CSRF), with no human ever saying yes.
   */
  async consentData(req: ValidatedAuthorizeRequest, userId: string): Promise<ConsentData> {
    const summaries = await this.memberships.listActiveMemberships(userId);
    const workspaces: ConsentWorkspace[] = [];
    for (const summary of summaries) {
      // Re-read the membership for its customRoleId: listActiveMemberships is a
      // display projection, and a custom role REPLACES the legacy role's
      // permission set — capping against the legacy role would over-offer.
      const membership = await this.memberships.getActiveMembership(userId, summary.workspaceId);
      if (!membership) continue;
      const held = await this.heldScopes(userId, summary.workspaceId, membership);
      workspaces.push({
        workspaceId: summary.workspaceId,
        workspaceName: summary.workspaceName,
        role: summary.role,
        grantableScopes: req.requestedScopes.filter((s) => held.has(s)),
      });
    }

    const logoUri = req.client.metadata?.logo_uri;
    return {
      client: {
        clientId: req.clientId,
        clientName: req.client.clientName,
        logoUri: typeof logoUri === 'string' ? logoUri : null,
      },
      requestedScopes: req.requestedScopes,
      resource: req.resource,
      redirectUri: req.redirectUri,
      state: req.state,
      workspaces,
    };
  }

  /**
   * Mint the code. `userId` is the SIGNED-IN caller (the controller takes it
   * from the JWT, never from the body) — this is the moment a human principal
   * gets bound to the grant, which is the whole point of the OAuth path.
   */
  async grant(
    req: ValidatedAuthorizeRequest,
    userId: string,
    input: { workspaceId: string; scopes: string[] },
  ): Promise<{ code: string; redirectTo: string }> {
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0) {
      throw new OAuthHttpException('invalid_scope', 'at least one scope must be granted');
    }

    // Cap 1 — a client cannot end up with more than it asked for, even if the
    // consent screen is driven directly.
    const notRequested = scopes.filter((s) => !req.requestedScopes.includes(s));
    if (notRequested.length) {
      throw new OAuthHttpException(
        'invalid_scope',
        `scope(s) were not requested by the client: ${notRequested.join(', ')}`,
      );
    }

    // Cap 2 — the consenting user must be an ACTIVE member of the workspace
    // they are granting access to. Without this, any signed-in user could
    // consent for any tenant by naming its id.
    const membership = await this.memberships.getActiveMembership(userId, input.workspaceId);
    if (!membership) {
      throw new OAuthHttpException(
        'access_denied',
        'you are not an active member of that workspace',
        HttpStatus.FORBIDDEN,
      );
    }

    // Cap 3 — and only up to the authority they themselves hold there.
    const held = await this.heldScopes(userId, input.workspaceId, membership);
    const exceeding = scopes.filter((s) => !held.has(s));
    if (exceeding.length) {
      throw new OAuthHttpException(
        'access_denied',
        `you cannot grant permission(s) you do not hold: ${exceeding.join(', ')}`,
        HttpStatus.FORBIDDEN,
      );
    }

    const code = newSecret();
    await this.prisma.mcpOAuthCode.create({
      data: {
        // Hashed at rest, exactly like ApiKey.keyHash: a database leak yields
        // no redeemable code, and the lookup stays an indexed equality match.
        codeHash: sha256Hex(code),
        clientId: req.clientId,
        workspaceId: input.workspaceId,
        userId,
        redirectUri: req.redirectUri,
        scopes,
        resource: req.resource,
        codeChallenge: req.codeChallenge,
        codeChallengeMethod: 'S256',
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    const url = new URL(req.redirectUri);
    url.searchParams.set('code', code);
    if (req.state !== null) url.searchParams.set('state', req.state);
    // RFC 9207: name ourselves in the response so a client holding several
    // authorization servers cannot be fed our code as if it came from another.
    url.searchParams.set('iss', mcpOAuthIssuer(this.baseUrl()));

    return { code, redirectTo: url.toString() };
  }

  /** The MCP-vocabulary scopes a user holds in one workspace. */
  private async heldScopes(
    _userId: string,
    workspaceId: string,
    membership: { role: string; customRoleId?: string | null },
  ): Promise<Set<string>> {
    const permissions = await this.roles.resolvePermissions({
      workspaceId,
      role: membership.role,
      customRoleId: membership.customRoleId ?? null,
    });
    return new Set(permissions.filter((p) => SCOPE_VOCABULARY.has(p)));
  }

  /**
   * RFC 6749 §3.3: the `scope` parameter is a space-delimited list. An unknown
   * value is refused rather than dropped — silently narrowing a grant produces
   * a token that fails later, at a call site with no way to explain why.
   */
  private parseScopes(raw: unknown): string[] {
    const value = str(raw);
    if (!value) {
      // No `scope` at all means "offer the caller everything they hold"; the
      // three caps in grant() still apply, so this widens the consent screen,
      // never the resulting token.
      return [...MCP_ALL_SCOPES];
    }
    const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
    const unknown = scopes.filter((s) => !SCOPE_VOCABULARY.has(s));
    if (unknown.length) {
      throw new OAuthHttpException('invalid_scope', `unknown scope(s): ${unknown.join(', ')}`);
    }
    return scopes;
  }

  private baseUrl(): string | undefined {
    return this.config.get<string>('PUBLIC_BASE_URL');
  }
}

/** Query/body values arrive as `unknown`; keep only non-empty strings. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The human-readable half of a CimdError. `HttpException.message` is the plain
 * string for these, but read it out of the response body too so a future
 * `BadRequestException(['a','b'])` shape cannot turn `error_description` into
 * `[object Object]`.
 */
function cimdMessage(err: CimdError): string {
  const body = err.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown })?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  return err.message;
}
