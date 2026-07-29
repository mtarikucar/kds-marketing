import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { McpOAuthMetadataController } from './mcp-oauth-metadata.controller';
import { MCP_ALL_SCOPES } from '../marketing/mcp/mcp-scopes';

const BASE = 'https://jeeta.example.com';

function withBase(baseUrl: string | undefined): McpOAuthMetadataController {
  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? baseUrl : undefined) } as any;
  return new McpOAuthMetadataController(config);
}

function controller(): McpOAuthMetadataController {
  return withBase(BASE);
}

describe('McpOAuthMetadataController', () => {
  describe('protected-resource metadata (RFC 9728)', () => {
    it('advertises the canonical MCP resource URI, which lives under the api prefix', () => {
      // The MCP transport is POST /api/mcp — the global `api` prefix applies to
      // it (see McpController). The resource identifier must be that exact URI
      // or a token audience check can never line up.
      expect(controller().protectedResource().resource).toBe(`${BASE}/api/mcp`);
    });

    it('points at us as the authorization server', () => {
      expect(controller().protectedResource().authorization_servers).toEqual([BASE]);
    });

    it('advertises the granular scope vocabulary', () => {
      const { scopes_supported } = controller().protectedResource();
      expect(scopes_supported).toEqual([...MCP_ALL_SCOPES]);
      expect(scopes_supported).toContain('leads.read');
      expect(scopes_supported).toContain('campaigns.send');
    });

    it('accepts the bearer token in the Authorization header only', () => {
      // RFC 6750 also defines form-body and query-string delivery; a token in a
      // query string lands in access logs and Referer headers, so neither is
      // offered.
      expect(controller().protectedResource().bearer_methods_supported).toEqual(['header']);
    });
  });

  describe('authorization-server metadata (RFC 8414)', () => {
    it('issues from the bare origin and points at our own endpoints', () => {
      const md = controller().authorizationServer();
      expect(md.issuer).toBe(BASE);
      expect(md.authorization_endpoint).toBe(`${BASE}/api/mcp-oauth/authorize`);
      expect(md.token_endpoint).toBe(`${BASE}/api/mcp-oauth/token`);
    });

    it('offers only the code grant with a rotating refresh', () => {
      const md = controller().authorizationServer();
      expect(md.response_types_supported).toEqual(['code']);
      expect(md.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    });

    it('requires PKCE S256 — `plain` is never advertised', () => {
      expect(controller().authorizationServer().code_challenge_methods_supported).toEqual(['S256']);
    });

    it('advertises CIMD and the RFC 9207 iss response parameter', () => {
      const md = controller().authorizationServer();
      expect(md.client_id_metadata_document_supported).toBe(true);
      expect(md.authorization_response_iss_parameter_supported).toBe(true);
    });

    it('advertises the same scope vocabulary as the resource metadata', () => {
      expect(controller().authorizationServer().scopes_supported).toEqual([...MCP_ALL_SCOPES]);
    });
  });

  describe('issuer derivation', () => {
    it('tolerates a trailing slash on PUBLIC_BASE_URL', () => {
      expect(withBase(`${BASE}/`).authorizationServer().issuer).toBe(BASE);
      expect(withBase(`${BASE}/`).protectedResource().resource).toBe(`${BASE}/api/mcp`);
    });

    it('refuses to serve metadata at all when PUBLIC_BASE_URL is unset', () => {
      // Deliberately NOT derived from the request Host header: an attacker who
      // can set Host would then get us to publish their origin as the issuer.
      expect(() => withBase(undefined).authorizationServer()).toThrow(ServiceUnavailableException);
      expect(() => withBase('').protectedResource()).toThrow(ServiceUnavailableException);
    });
  });

  describe('scope vocabulary', () => {
    it('covers every scope the MCP tool catalogue actually demands', () => {
      // scopes_supported is a promise: a client that asks for exactly these
      // must be able to reach the whole surface. If a tool is added with a
      // scope the metadata never advertises, that tool is unreachable over
      // OAuth and nothing else would notice.
      const dir = join(__dirname, '..', 'marketing', 'mcp', 'tools');
      const declared = new Set<string>();
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.tools.ts'))) {
        const src = readFileSync(join(dir, file), 'utf8');
        for (const m of src.matchAll(/scopes:\s*\[([^\]]*)\]/g)) {
          for (const s of m[1].matchAll(/'([^']+)'/g)) declared.add(s[1]);
        }
      }
      expect(declared.size).toBeGreaterThan(0); // the scan itself must not silently find nothing
      expect([...declared].sort()).toEqual(
        [...declared].filter((s) => (MCP_ALL_SCOPES as readonly string[]).includes(s)).sort(),
      );
    });
  });
});
