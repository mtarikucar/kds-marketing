import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as bodyParser from 'body-parser';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { customDomainHostMiddleware } from './modules/marketing/custom-domains/custom-domain.middleware';
import { CustomDomainsService } from './modules/marketing/custom-domains/custom-domains.service';
import { SitesService } from './modules/marketing/sites/sites.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HttpLoggingInterceptor } from './common/interceptors/http-logging.interceptor';
import { setupSwagger } from './swagger';

/**
 * Single source of truth for the HTTP wiring (DRY).
 *
 * Both the production bootstrap (`main.ts`) and the e2e harness
 * (`test/utils/test-app.ts`) call this, so an e2e test exercises the EXACT
 * middleware/pipe/prefix stack that ships — request-id, raw-body webhook
 * routes, helmet, CORS, the global ValidationPipe, the `api` prefix. If the two
 * ever drift, the e2e suite stops being end-to-end; keeping the wiring here
 * makes that impossible.
 *
 * Caller is responsible for `NestFactory.create(AppModule, { bodyParser: false })`
 * (the raw-body webhook routes below depend on the built-in parser being off)
 * and for `app.listen()`.
 */
export function configureApp(app: NestExpressApplication): void {
  // Trust proxy so `req.ip` and the rate-limiter see the real client IP behind
  // the load balancer. Default 1 = one LB hop (same as the source).
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const parsed = Number(trustProxy);
    app.set('trust proxy', Number.isFinite(parsed) ? parsed : trustProxy);
  } else {
    app.set('trust proxy', 1);
  }

  // Correlation id first, so every request — including ones the body parser
  // later rejects — carries an X-Request-ID.
  app.use(requestIdMiddleware);

  // Stripe webhook signatures are computed over the EXACT payload bytes — mount
  // a raw parser on that one route BEFORE the JSON parser so the verifier sees
  // the original body (re-serialized JSON never verifies).
  app.use('/api/billing/webhooks/stripe', bodyParser.raw({ type: '*/*', limit: '500kb' }));

  // Meta (WhatsApp/Instagram/Messenger) webhook — X-Hub-Signature-256 is an
  // HMAC over the raw bytes, so the same raw-before-JSON treatment applies.
  app.use('/api/public/channels/meta/webhook', bodyParser.raw({ type: '*/*', limit: '1mb' }));
  // TikTok DM webhook — HMAC-SHA256 over the raw body, same raw-before-JSON rule.
  app.use('/api/public/channels/tiktok/webhook', bodyParser.raw({ type: '*/*', limit: '1mb' }));
  // Inbound Email webhook — HMAC-SHA256 over the raw body (EMAIL_INBOUND_SECRET).
  app.use('/api/public/channels/email/webhook', bodyParser.raw({ type: '*/*', limit: '2mb' }));
  // ESP delivery-feedback (bounces/complaints) — HMAC over the raw body too.
  app.use('/api/public/esp/feedback', bodyParser.raw({ type: '*/*', limit: '2mb' }));

  // CSV lead imports advertise up to 50,000 rows / 10MB (the upload DTO
  // validates exactly that) — the generic 200kb JSON cap below would reject any
  // realistically-sized file before it ever reached the controller. Mount a
  // larger parser on just this route BEFORE the generic one (body-parser skips
  // already-parsed bodies); 12mb leaves headroom for JSON string escaping.
  app.use('/api/marketing/imports', bodyParser.json({ limit: '12mb' }));

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

  // Custom-domain white-label (Epic 13). A pure pass-through unless
  // CUSTOM_DOMAINS_ENABLED is set — on the live deploy this only adds an env
  // check. Registered AFTER helmet so a served white-label page carries the same
  // security headers (CSP/nosniff/frame-ancestors) as every other public page.
  // When enabled, a request whose Host matches a VERIFIED custom domain is served
  // that workspace's public site; everything else (incl. /api) falls through.
  app.use(customDomainHostMiddleware(app.get(CustomDomainsService), app.get(SitesService)));

  // SAME global prefix as the monorepo backend, so every existing route
  // (/api/marketing/..., /api/internal/...) is unchanged and the marketing
  // frontend works as-is.
  app.setGlobalPrefix('api');

  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
        // Credentialed CORS + '*' is forbidden by the spec and by browsers;
        // reject it explicitly so a careless env value can't try.
        .filter((o) => o !== '*')
        // In production every allowed origin must be https — an http origin
        // would let a network attacker read credentialed responses.
        .filter((o) => !isProd || o.startsWith('https://'))
    : ['http://localhost:5173', 'http://localhost:5179'];

  // Fail fast rather than boot a production service that rejects every browser
  // origin (or was misconfigured to allow none meaningfully).
  if (isProd && allowedOrigins.length === 0) {
    throw new Error(
      'CORS_ORIGIN must list at least one https origin in production',
    );
  }

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
      // Reject unknown properties outright (400) instead of silently stripping
      // them — closes the mass-assignment surface where a client smuggles extra
      // keys hoping one maps to a sensitive field.
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Uniform error envelope + correlation id on every error response.
  app.useGlobalFilters(new AllExceptionsFilter());

  // One correlated access-log line per request (health probes excluded).
  app.useGlobalInterceptors(new HttpLoggingInterceptor());

  // OpenAPI docs at /api/docs (+ /api/docs-json).
  setupSwagger(app);
}
