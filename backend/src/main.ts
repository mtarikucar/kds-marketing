import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';

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
    // IngestTokenGuard fails closed without it, but only when an ingest
    // request arrives — boot-gate it so a misconfigured deploy fails loudly.
    'MARKETING_INGEST_TOKEN',
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
  });

  // Trust proxy so `req.ip` and rate-limiter tracking see the real client IP
  // behind the load balancer. Default 1 = one LB hop (same as the source).
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const parsed = Number(trustProxy);
    app.set('trust proxy', Number.isFinite(parsed) ? parsed : trustProxy);
  } else {
    app.set('trust proxy', 1);
  }

  // Tight generic body limit (the marketing API has no file/webhook payloads;
  // the bulk lead-ingest endpoint caps its batch size in the DTO).
  app.use(bodyParser.json({ limit: '200kb' }));
  app.use(bodyParser.urlencoded({ limit: '100kb', extended: true }));

  // Security headers. API-only service — CSP kept from the source defaults.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'https:'],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // SAME global prefix as the monorepo backend, so every existing route
  // (/api/marketing/..., /api/internal/...) is unchanged and the marketing
  // frontend works as-is.
  app.setGlobalPrefix('api');

  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:5173', 'http://localhost:5179'];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Total-Count', 'X-Request-ID'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Nest calls onModuleDestroy on SIGTERM/SIGINT so Prisma drains cleanly on
  // rolling restarts.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);

  // eslint-disable-next-line no-console
  console.log(`🚀 Marketing service is running on: http://localhost:${port}`);
}

bootstrap();
