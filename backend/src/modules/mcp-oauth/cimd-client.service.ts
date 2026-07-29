import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { safeFetch } from '../../common/util/safe-fetch';

/**
 * CIMD — Client ID Metadata Documents.
 *
 * The current MCP spec deprecated Dynamic Client Registration (RFC 7591) in
 * favour of CIMD: instead of registering, a client presents an HTTPS URL as its
 * `client_id`, and the authorization server fetches that URL to learn who the
 * client is. There is no /register endpoint here as a result.
 *
 * The single security property that makes this safe is the self-reference
 * check: the document must claim the very URL it was fetched from. Without it,
 * anyone could host a document naming someone else's `client_id` and inherit
 * their identity on our consent screen.
 *
 * The URL is chosen by an unauthenticated caller, so the fetch goes through
 * {@link safeFetch} (SSRF guard: scheme allow-list, private/loopback/link-local
 * IP rejection, re-validated redirects, hard timeout). A plain `fetch` here
 * would be a server-side request forgery hole straight into the private
 * network and the cloud metadata endpoint.
 */

/** Cache lifetime bounds. The client controls `Cache-Control`, so it is clamped. */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h when the response says nothing
const MIN_TTL_MS = 60 * 1000; // never re-fetch on every single authorization
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // never pin a document (or a compromise) forever

/** Refuse to buffer an unbounded body from a URL a stranger chose. */
const MAX_DOCUMENT_BYTES = 256 * 1024;

const FETCH_TIMEOUT_MS = 5_000;

export type CimdErrorCode = 'invalid_request' | 'invalid_client';

/**
 * A rejected `client_id`. Extends BadRequestException so an unhandled one is
 * still a 400 rather than a 500; `oauthError` lets the authorize endpoint
 * render the correct OAuth error code.
 */
export class CimdError extends BadRequestException {
  constructor(
    readonly oauthError: CimdErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CimdError';
  }
}

export interface ResolvedCimdClient {
  /** The HTTPS URL the client presented, which is also its identity. */
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  /** Everything else the document carried (logo_uri, client_uri, scope, …). */
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class CimdClientService {
  private readonly logger = new Logger(CimdClientService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a `client_id` URL to a validated client, fetching and caching the
   * document if we have no live copy.
   *
   * @throws {CimdError} if the URL or the document is unacceptable.
   */
  async resolveClient(clientId: string): Promise<ResolvedCimdClient> {
    this.assertHttpsUrl(clientId);

    const cached = await this.prisma.mcpOAuthClient.findUnique({ where: { clientId } });
    if (cached && cached.expiresAt.getTime() > Date.now()) {
      return this.toResolved(cached);
    }

    const { document, ttlMs } = await this.fetchDocument(clientId);
    const { clientName, redirectUris, metadata } = this.validate(clientId, document);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const data = {
      clientName,
      redirectUris: redirectUris as unknown as object,
      metadata: metadata as unknown as object,
      fetchedAt: now,
      expiresAt,
    };
    const row = await this.prisma.mcpOAuthClient.upsert({
      where: { clientId },
      create: { clientId, ...data },
      update: data,
    });
    return this.toResolved(row);
  }

  /**
   * A `client_id` must be an https URL. Additionally rejected:
   *  - credentials in the authority — we would leak them on every fetch, and
   *    they make two spellings of the same identity possible;
   *  - a fragment — it is never sent to the server, so the document could not
   *    echo back a byte-identical `client_id` and the exact-match check below
   *    would be meaningless.
   */
  private assertHttpsUrl(clientId: string): URL {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new CimdError('invalid_request', 'client_id must be an https:// URL');
    }
    if (url.protocol !== 'https:') {
      throw new CimdError('invalid_request', 'client_id must use the https scheme');
    }
    if (url.username || url.password) {
      throw new CimdError('invalid_request', 'client_id must not carry credentials');
    }
    if (url.hash) {
      throw new CimdError('invalid_request', 'client_id must not contain a fragment');
    }
    return url;
  }

  private async fetchDocument(
    clientId: string,
  ): Promise<{ document: Record<string, unknown>; ttlMs: number }> {
    let res: Response;
    try {
      res = await safeFetch(clientId, {
        headers: { accept: 'application/json' },
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      // Covers the SSRF guard's own refusals as well as DNS/TLS/timeout
      // failures. Either way it is the CLIENT's URL that is unusable, so this
      // is a 4xx to the caller, not a 500 for us.
      this.logger.warn(`CIMD fetch failed for ${clientId}: ${(err as Error).message}`);
      throw new CimdError('invalid_client', 'could not fetch the client_id metadata document');
    }

    if (!res.ok) {
      throw new CimdError(
        'invalid_client',
        `client_id metadata document returned HTTP ${res.status}`,
      );
    }

    const declaredLength = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
      throw new CimdError('invalid_client', 'client_id metadata document is too large');
    }

    const body = await res.text();
    if (body.length > MAX_DOCUMENT_BYTES) {
      throw new CimdError('invalid_client', 'client_id metadata document is too large');
    }

    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      throw new CimdError('invalid_client', 'client_id metadata document is not valid JSON');
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new CimdError('invalid_client', 'client_id metadata document must be a JSON object');
    }

    return { document: document as Record<string, unknown>, ttlMs: this.ttlFrom(res) };
  }

  /** Honour `Cache-Control: max-age`, clamped; 1h when the response is silent. */
  private ttlFrom(res: Response): number {
    const cacheControl = res.headers.get('cache-control');
    if (!cacheControl) return DEFAULT_TTL_MS;
    // no-store / no-cache means "do not reuse this copy", but re-fetching on
    // every authorization request would let a client drive our egress. Honour
    // the intent as far as the floor allows.
    if (/(?:^|[,\s])no-(?:store|cache)(?:\b|$)/i.test(cacheControl)) return MIN_TTL_MS;

    const match = /(?:^|[,\s])max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl);
    if (!match) return DEFAULT_TTL_MS;
    const ms = Number(match[1]) * 1000;
    if (!Number.isFinite(ms)) return DEFAULT_TTL_MS;
    return Math.min(Math.max(ms, MIN_TTL_MS), MAX_TTL_MS);
  }

  private validate(
    clientId: string,
    document: Record<string, unknown>,
  ): { clientName: string | null; redirectUris: string[]; metadata: Record<string, unknown> | null } {
    // THE check. Byte-exact, deliberately: any normalisation here (case,
    // trailing slash, default port) would let two spellings resolve to one
    // identity and reopen the impersonation this is meant to close.
    if (document.client_id !== clientId) {
      throw new CimdError(
        'invalid_client',
        'client_id metadata document does not claim the URL it was fetched from',
      );
    }

    const { client_id: _id, client_name, redirect_uris, ...rest } = document;

    if (
      !Array.isArray(redirect_uris) ||
      redirect_uris.length === 0 ||
      !redirect_uris.every((u) => typeof u === 'string' && u.length > 0)
    ) {
      throw new CimdError(
        'invalid_client',
        'client_id metadata document must declare a non-empty redirect_uris array of strings',
      );
    }

    return {
      clientName: typeof client_name === 'string' && client_name.length > 0 ? client_name : null,
      redirectUris: redirect_uris as string[],
      metadata: Object.keys(rest).length > 0 ? rest : null,
    };
  }

  private toResolved(row: {
    clientId: string;
    clientName: string | null;
    redirectUris: unknown;
    metadata: unknown;
  }): ResolvedCimdClient {
    return {
      clientId: row.clientId,
      clientName: row.clientName,
      redirectUris: (row.redirectUris as string[]) ?? [],
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    };
  }
}
