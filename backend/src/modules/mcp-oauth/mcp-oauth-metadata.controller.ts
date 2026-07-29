import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MCP_ALL_SCOPES } from '../marketing/mcp/mcp-scopes';
import {
  MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_TOKEN_PATH,
  mcpCanonicalResource,
  mcpOAuthIssuer,
} from './mcp-oauth.config';

/**
 * OAuth discovery documents for the MCP connector.
 *
 * Two documents, both served at the ROOT of the origin (never under the global
 * `api` prefix — see `MCP_OAUTH_WELL_KNOWN_EXCLUSIONS` and the routing spec):
 *
 *  - RFC 9728 protected-resource metadata, which tells a client that the MCP
 *    endpoint is protected and which authorization server guards it. A 401
 *    from `/api/mcp` points here via `WWW-Authenticate: resource_metadata=…`.
 *  - RFC 8414 authorization-server metadata, which is that authorization
 *    server describing itself.
 *
 * Both are public and unauthenticated by design — discovery has to work before
 * the client holds any credential.
 */
@Controller('.well-known')
export class McpOAuthMetadataController {
  constructor(private readonly config: ConfigService) {}

  /**
   * RFC 9728 §3: metadata for `https://<host>/api/mcp` lives at
   * `/.well-known/oauth-protected-resource` + the resource's own path, so the
   * `/api/mcp` suffix on this route is the resource path, not the api prefix.
   */
  @Get('oauth-protected-resource/api/mcp')
  protectedResource(): ProtectedResourceMetadata {
    const base = this.baseUrl();
    return {
      resource: mcpCanonicalResource(base),
      authorization_servers: [mcpOAuthIssuer(base)],
      scopes_supported: [...MCP_ALL_SCOPES],
      // RFC 6750 also allows the token in a form body or query string. A token
      // in a query string leaks into access logs, proxies and Referer headers,
      // so only the header form is offered.
      bearer_methods_supported: ['header'],
    };
  }

  @Get('oauth-authorization-server')
  authorizationServer(): AuthorizationServerMetadata {
    const base = this.baseUrl();
    const issuer = mcpOAuthIssuer(base);
    return {
      issuer,
      authorization_endpoint: `${issuer}${MCP_OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${issuer}${MCP_OAUTH_TOKEN_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // PKCE is mandatory and `plain` is never accepted, so S256 is the only
      // method advertised (OAuth 2.1 / RFC 7636).
      code_challenge_methods_supported: ['S256'],
      // CIMD clients are public and hold no secret. Without this, RFC 8414 §2
      // says a client MUST assume `client_secret_basic`, which we do not
      // implement — it would send credentials we have no way to check.
      token_endpoint_auth_methods_supported: ['none'],
      // Client ID Metadata Documents replace Dynamic Client Registration
      // (deprecated by the current MCP spec): a `client_id` is an HTTPS URL we
      // fetch and validate, so there is no /register endpoint here.
      client_id_metadata_document_supported: true,
      // RFC 9207: every authorization response carries `iss`, so a client can
      // detect a mix-up attack where a response is replayed from another AS.
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...MCP_ALL_SCOPES],
    };
  }

  private baseUrl(): string | undefined {
    return this.config.get<string>('PUBLIC_BASE_URL');
  }
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
  authorization_response_iss_parameter_supported: boolean;
  scopes_supported: string[];
}
