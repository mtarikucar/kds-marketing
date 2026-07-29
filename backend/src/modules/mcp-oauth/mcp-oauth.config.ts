import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Shared URL vocabulary for the MCP OAuth 2.1 authorization server.
 *
 * Everything here hangs off ONE fact: the MCP transport is served at
 * `POST /api/mcp`. `app.config.ts` applies a global `api` prefix, and
 * `McpController` declares `@Controller('mcp')`, so the resource identifier
 * carries the prefix — see `mcp.controller.ts`'s own header comment.
 */

/** Path of the MCP endpoint relative to the origin, including the api prefix. */
export const MCP_RESOURCE_PATH = '/api/mcp';

/** Where the authorization server's own endpoints live (Faz 3 Tasks 4-5). */
export const MCP_OAUTH_AUTHORIZE_PATH = '/api/mcp-oauth/authorize';
export const MCP_OAUTH_TOKEN_PATH = '/api/mcp-oauth/token';

/**
 * RFC 9728 §3: the protected-resource metadata URL is built by inserting
 * `/.well-known/oauth-protected-resource` between the host component and the
 * PATH component of the resource identifier — i.e. the resource's path is a
 * SUFFIX of the well-known path, it does not replace it:
 *
 *   resource  https://host/api/mcp
 *   metadata  https://host/.well-known/oauth-protected-resource/api/mcp
 *
 * (Verified against RFC 9728 §3 rather than assumed. Note this is the exact
 * opposite of the intuitive `/api/.well-known/...` reading, and also differs
 * from the design spec's §5.1 sketch, which was written before Faz 1-2
 * established that the MCP endpoint sits under the `api` prefix.)
 */
export const PROTECTED_RESOURCE_METADATA_PATH =
  `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}` as const;

/**
 * RFC 8414 §3: our issuer is the bare origin (no path component), so the
 * authorization-server metadata sits at the plain well-known path.
 */
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server' as const;

/**
 * Routes that MUST be excluded from `setGlobalPrefix('api')`. Both RFCs put
 * metadata at the ROOT of the origin; under the prefix they would sit at
 * `/api/.well-known/...`, where no OAuth client will ever look, and discovery
 * silently fails with a 404 that looks like "this server has no OAuth".
 */
export const MCP_OAUTH_WELL_KNOWN_EXCLUSIONS = [
  PROTECTED_RESOURCE_METADATA_PATH,
  AUTHORIZATION_SERVER_METADATA_PATH,
] as const;

/**
 * The issuer identifier: `PUBLIC_BASE_URL` with any trailing slash removed.
 *
 * Deliberately NOT derived from the request's Host header. The issuer is the
 * value clients pin their discovery and their RFC 9207 `iss` check to; letting
 * a request header choose it would let an attacker who can set Host have us
 * publish their origin as ours. If the deployment has not been configured,
 * refuse to publish metadata at all rather than publish something wrong.
 */
export function mcpOAuthIssuer(publicBaseUrl: string | undefined): string {
  const base = (publicBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new ServiceUnavailableException(
      'PUBLIC_BASE_URL is not configured — OAuth metadata cannot be published',
    );
  }
  return base;
}

/** The canonical MCP resource URI (the RFC 8707 audience of every token). */
export function mcpCanonicalResource(publicBaseUrl: string | undefined): string {
  return `${mcpOAuthIssuer(publicBaseUrl)}${MCP_RESOURCE_PATH}`;
}
