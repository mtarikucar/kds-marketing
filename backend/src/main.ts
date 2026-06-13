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

  // MARKETING_SECRET_KEY is the AES-256-GCM master key that seals channel/PSP
  // secrets (consumed from Phase F P2 on). It's optional in P1, but if it's
  // present it MUST decode to exactly 32 bytes or the box throws at first
  // use — validate the format now rather than discover it mid-request.
  const secretKey = process.env.MARKETING_SECRET_KEY;
  if (secretKey) {
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
