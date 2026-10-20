import {
  ArgumentsHost,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  HttpCode,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { IngestTokenGuard } from '../guards/ingest-token.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { header } from '../channels/inbound/webhook-verifier';
import { WebhookReplayStore } from '../channels/inbound/webhook-verifier/webhook-replay.store';
import { commerceIngestEnabled } from './commerce-ingest.flag';
import { verifyCommerceSignature } from './commerce-signature';
import { CommerceIngestError, CommerceIngestService, IngestResult } from './commerce-ingest.service';
import { COMMERCE_SOURCE_SLUG, CommerceSourcesService } from './commerce-sources.service';
import { parseOrderEvent } from './dto/order-event.dto';

/** Replay-store namespace for this endpoint. */
const REPLAY_PROVIDER = 'commerce';

/**
 * Runs before the token guard: with the flag off the route answers exactly
 * like a route that does not exist, whatever credentials were sent.
 */
@Injectable()
export class CommerceIngestEnabledGuard implements CanActivate {
  canActivate(context: import('@nestjs/common').ExecutionContext): boolean {
    if (commerceIngestEnabled()) return true;
    const req = context.switchToHttp().getRequest<Request>();
    throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl ?? req.url}`);
  }
}

/** The ingest-token guard's messages, given the contract's codes (§1.6). */
const GUARD_CODES: Record<string, string> = {
  'Missing ingest token': 'MISSING_INGEST_TOKEN',
  'Invalid ingest token': 'INVALID_INGEST_TOKEN',
};

/**
 * One error shape for every refusal on this endpoint:
 * `{ ok: false, code, message, details? }`. A 5xx says nothing about why —
 * the sender only needs to know to retry.
 */
@Catch()
export class CommerceIngestExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('CommerceIngest');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (!(err instanceof HttpException)) {
      this.logger.error(`order ingest failed: ${String((err as Error)?.message ?? err)}`);
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', message: 'The event was not recorded; retry later.' });
      return;
    }
    const status = err.getStatus();
    const body = err.getResponse();
    if (status === 404) {
      // Indistinguishable from an unknown route.
      res.status(404).json(body);
      return;
    }
    if (typeof body === 'object' && body && (body as { ok?: unknown }).ok === false) {
      res.status(status).json(body);
      return;
    }
    const message = typeof body === 'string' ? body : String((body as { message?: unknown })?.message ?? err.message);
    const code = GUARD_CODES[message] ?? (status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`);
    res.status(status).json({ ok: false, code, message });
  }
}

/**
 * POST /api/marketing/commerce/ingest/orders — a workspace's store reports an
 * order event (contract §1). Order of checks: flag → ingest token (workspace)
 * → x-jeeta-source (which secret) → signature over the raw bytes → body →
 * replay store → the service's durable idempotency.
 *
 * The body arrives as raw bytes (app.config.ts mounts a raw parser on this
 * prefix before the JSON one); nothing is parsed until the signature holds.
 */
@Controller('marketing/commerce/ingest')
@MarketingRoute()
@UseGuards(CommerceIngestEnabledGuard, IngestTokenGuard)
@UseFilters(CommerceIngestExceptionFilter)
// `default` is the global throttler's name; any other key is silently ignored.
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class CommerceIngestController {
  private readonly logger = new Logger(CommerceIngestController.name);

  constructor(
    private readonly ingestService: CommerceIngestService,
    private readonly sources: CommerceSourcesService,
    private readonly replay: WebhookReplayStore,
  ) {}

  @Post('orders')
  @HttpCode(200)
  async orders(@Req() req: Request & { ingestWorkspaceId?: string }): Promise<IngestResult> {
    const workspaceId = req.ingestWorkspaceId;
    if (!workspaceId) throw new CommerceIngestError(401, 'INVALID_INGEST_TOKEN', 'Invalid ingest token');

    const slug = header(req as never, 'x-jeeta-source') ?? '';
    const resolved = COMMERCE_SOURCE_SLUG.test(slug)
      ? await this.sources.resolveForVerification(workspaceId, slug)
      : null;
    if (!resolved) {
      throw new CommerceIngestError(401, 'UNKNOWN_SOURCE', 'x-jeeta-source names no active commerce source in this workspace.');
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const verdict = verifyCommerceSignature({
      rawBody: raw,
      timestamp: header(req as never, 'x-jeeta-timestamp'),
      signatureHeader: header(req as never, 'x-jeeta-signature'),
      secrets: resolved.secrets,
    });
    if (verdict.ok === false) {
      // strictNullChecks is off in this project, so the union does not narrow.
      const { code } = verdict as Extract<typeof verdict, { ok: false }>;
      // The reason code only; no header or secret value is ever logged.
      this.logger.warn(`order event rejected for source ${resolved.source.id}: ${code}`);
      throw new CommerceIngestError(
        401,
        code,
        code === 'STALE_TIMESTAMP'
          ? 'x-jeeta-timestamp is more than 300 seconds from the server clock.'
          : 'x-jeeta-signature does not match the body.',
      );
    }

    const parsed = await parseOrderEvent(raw);
    if (parsed.ok === false) {
      const { code, message, details } = parsed as Extract<typeof parsed, { ok: false }>;
      throw new CommerceIngestError(400, code, message, details ? { details } : {});
    }

    const { event } = parsed as Extract<typeof parsed, { ok: true }>;

    const bodyHash = WebhookReplayStore.hashBody(raw);
    // eventId is unique only within a source, so the replay key carries it.
    const replayKey = `${resolved.source.id}:${event.eventId}`;
    const seen = await this.replay.check(REPLAY_PROVIDER, replayKey, bodyHash);
    if (seen.seen && !seen.sameBody) {
      throw new CommerceIngestError(409, 'EVENT_ID_REUSED', `eventId ${event.eventId} was already used for a different body.`);
    }

    const result = await this.ingestService.ingest(workspaceId, resolved.source, event, bodyHash);
    // Spent only after success: a failed attempt must stay retryable.
    await this.replay.remember(REPLAY_PROVIDER, replayKey, bodyHash);
    return result;
  }
}
