import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.config';
import { JsonLogger } from './common/logging/json-logger';

/**
 * Fail-fast env validation BEFORE Nest touches anything — missing secrets
 * previously surfaced as a first-request 500; now abort startup. Slim
 * standalone version of the monorepo's validateEnv() with only the keys this
 * service actually reads.
 */
function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const required = [
    'DATABASE_URL',
    // Independent marketing auth realm (validated again, with length +
    // distinctness checks, inside MarketingModule's JwtModule factory).
    'MARKETING_JWT_SECRET',
    'MARKETING_JWT_REFRESH_SECRET',
    // The nightly research routine's surface (/api/internal/research/*);
    // ResearchTokenGuard fails closed without it — boot-gate it so a
    // misconfigured deploy fails loudly. (Lead ingest itself now uses
    // per-workspace DB-backed tokens, no env needed.)
    'RESEARCH_ROUTINE_TOKEN',
    // Service-to-service token for /api/internal/* (both directions).
    'INTERNAL_SERVICE_TOKEN',
    // Platform (superadmin) realm — operator login + workspace admin.
    'PLATFORM_JWT_SECRET',
    // Where the core service lives (CoreProvisioningPort HTTP client).
    'CORE_SERVICE_URL',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    // In dev we warn instead of abort so the service can boot far enough to
    // explore the API; provisioning/internal calls will fail with clear errors.
    const msg = `Missing required environment variables: ${missing.join(', ')}`;
    if (isProd) {
      // eslint-disable-next-line no-console
      console.error(`[env] ${msg}`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.warn(`[env] ${msg}`);
  }

  // Phase F (AI). Runtime AI is gated by AnthropicService.isEnabled(); a
  // missing key simply disables the AI surfaces (compose 503s, the engine
  // no-ops) — it must NEVER take the whole app down, since the v1.x lead /
  // billing features don't need it. So this is a loud WARNING, not a hard
  // exit: shipping to prod without a key (and without the AI_DISABLED
  // kill-switch) is surfaced, but the service still boots.
  if (isProd && process.env.AI_DISABLED !== '1' && !process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] ANTHROPIC_API_KEY is not set — AI features will report "not configured" until you add it (or set AI_DISABLED=1 to silence this).',
    );
  }

  // Rate limiter: without REDIS_URL the ThrottlerModule falls back to a
  // per-process in-memory store, so under more than one replica the global
  // limit is diluted (a "5/min" rule becomes 5×N). Single-replica deploys are
  // fine — hence a warning, not a hard exit.
  if (isProd && !process.env.REDIS_URL) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] REDIS_URL is not set — the rate limiter uses per-replica in-memory buckets; the global limit will be diluted under >1 replica. Set REDIS_URL to a shared Redis for a correct distributed limit.',
    );
  }

  // GRAPH_API_VERSION pins the Meta Graph API version for every outbound Graph
  // call (messaging/social/ads/reviews). Unset → the built-in default (v19.0).
  // A malformed value silently falls back, so warn to keep the default
  // intentional rather than a typo.
  const graphVersion = process.env.GRAPH_API_VERSION;
  if (graphVersion && !/^v\d+\.\d+$/.test(graphVersion)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] GRAPH_API_VERSION="${graphVersion}" is malformed (expected like v19.0) — falling back to the built-in default.`,
    );
  }

  // MARKETING_SECRET_KEY is the AES-256-GCM master key that seals channel/PSP
  // secrets AND mints the NetGSM MO callback tokens. It is now load-bearing for
  // live omnichannel, so it is REQUIRED in production (fail fast rather than
  // 503 on the first channel save / forge-open the unsigned MO webhook). When
  // present it MUST decode to exactly 32 bytes or the box throws at first use.
  const secretKey = process.env.MARKETING_SECRET_KEY;
  if (!secretKey) {
    if (isProd) {
      // eslint-disable-next-line no-console
      console.error(
        '[env] MARKETING_SECRET_KEY is required in production — channel/PSP secrets and NetGSM callback tokens cannot be sealed/minted without it. Generate with: openssl rand -base64 32',
      );
      process.exit(1);
    }
  } else {
    let bytes = 0;
    try {
      bytes = Buffer.from(secretKey, 'base64').length;
    } catch {
      bytes = 0;
    }
    if (bytes !== 32) {
      // eslint-disable-next-line no-console
      console.error(
        '[env] MARKETING_SECRET_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)',
      );
      process.exit(1);
    }
  }
}

validateEnv();

// Global unhandled error handlers (Sentry removed at the split — plug your
// APM of choice in here).
process.on('unhandledRejection', (reason: any) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // Buffer boot logs until the structured logger is installed, so even
    // startup lines come out as correlated JSON in production.
    bufferLogs: true,
  });

  // Structured, correlation-aware logging for the whole app: every
  // `new Logger(ctx)` call now emits a JSON line carrying the request's
  // X-Request-ID (from AsyncLocalStorage). Dev stays pretty unless LOG_FORMAT=json.
  app.useLogger(new JsonLogger());

  // All HTTP wiring (request-id, raw-body webhooks, helmet, CORS, global pipe,
  // `api` prefix) lives in one place so the e2e harness boots an identical app.
  configureApp(app);

  // Nest calls onModuleDestroy on SIGTERM/SIGINT so Prisma drains cleanly on
  // rolling restarts.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);

  // eslint-disable-next-line no-console
  console.log(`🚀 Marketing service is running on: http://localhost:${port}`);
}

bootstrap();
