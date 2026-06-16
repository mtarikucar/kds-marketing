import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.config';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Shared e2e harness.
 *
 * Boots the REAL {@link AppModule} through the SAME `configureApp` wiring that
 * `main.ts` ships (request-id, raw-body webhook routes, helmet, CORS, the
 * global ValidationPipe, the `api` prefix, the ThrottlerGuard), so an e2e test
 * exercises the production request pipeline end to end — guards → pipes →
 * throttler → controllers → serialization.
 *
 * The ONLY seam we cut is the database: `PrismaService` is replaced with a deep
 * mock so the suite runs anywhere (this sandbox has no Postgres) and CI doesn't
 * need a live DB. Tests that want to drive a data path set return values on the
 * returned `prisma` mock. A future real-DB mode can swap the override for a
 * throwaway schema without touching any spec (they only touch HTTP + the mock).
 */

/** Strong, realm-distinct secrets that satisfy MarketingModule's JwtModule factory. */
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test?schema=public',
  MARKETING_JWT_SECRET: 'e2e-marketing-access-secret-000000000000000000',
  MARKETING_JWT_REFRESH_SECRET: 'e2e-marketing-refresh-secret-1111111111111111',
  PLATFORM_JWT_SECRET: 'e2e-platform-operator-secret-2222222222222222',
  INTERNAL_SERVICE_TOKEN: 'e2e-internal-service-token-3333333333',
  RESEARCH_ROUTINE_TOKEN: 'e2e-research-routine-token-4444444444',
  CORE_SERVICE_URL: 'http://core.test.local:3000',
  // Keep the AI surfaces inert and quiet during e2e.
  AI_DISABLED: '1',
} as const;

export function applyTestEnv(): void {
  for (const [k, v] of Object.entries(TEST_ENV)) {
    process.env[k] = v;
  }
  // Force the in-memory throttler store regardless of the host environment, so
  // the rate-limit e2e is deterministic (per-app buckets that reset each boot)
  // and matches CI, which has no Redis. The Redis store is covered separately.
  delete process.env.REDIS_URL;
}

export interface TestApp {
  app: NestExpressApplication;
  prisma: DeepMockProxy<PrismaClient>;
}

/**
 * Build and initialise the app for a spec.
 *
 * @param customize optional hook to add per-spec provider overrides on top of
 *                  the always-mocked PrismaService.
 */
export async function createTestApp(
  customize?: (builder: TestingModuleBuilder) => void,
): Promise<TestApp> {
  applyTestEnv();

  const prisma = mockDeep<PrismaClient>();
  // Raw queries default to an empty result set: the readiness probe only needs
  // them not to throw, and the OutboxWorker's poll claims zero rows and stays
  // quiet. (Specs that drive readiness "down" override this transiently.)
  (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
  (prisma.$queryRawUnsafe as jest.Mock).mockResolvedValue([]);

  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma);

  if (customize) customize(builder);

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();

  return { app, prisma };
}

export async function closeTestApp(app?: INestApplication): Promise<void> {
  if (app) await app.close();
}

/**
 * REAL-DATABASE harness (backlog #7). Identical wiring to {@link createTestApp},
 * but the PrismaService is NOT mocked — it talks to the Postgres at the ambient
 * `DATABASE_URL` (provisioned by the SessionStart hook / CI service). Used by the
 * full lead-lifecycle flow to assert real cross-table data consistency.
 *
 * Opt-in: specs guard on `E2E_REAL_DB === '1'` and skip otherwise, so the default
 * (DB-less, mocked) suite — and CI without a database — is unaffected.
 */
export function realDbEnabled(): boolean {
  return process.env.E2E_REAL_DB === '1';
}

export async function createRealDbTestApp(
  customize?: (builder: TestingModuleBuilder) => void,
): Promise<{ app: NestExpressApplication; prisma: PrismaService }> {
  // Apply the test secrets but KEEP the real DATABASE_URL (don't clobber it with
  // the fake one in TEST_ENV); force the in-memory throttler store.
  for (const [k, v] of Object.entries(TEST_ENV)) {
    if (k === 'DATABASE_URL') continue;
    process.env[k] = v;
  }
  delete process.env.REDIS_URL;

  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) customize(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma };
}

/**
 * Mint a marketing-realm access token the way MarketingAuthService does, signed
 * with the test secret + HS256 so {@link MarketingGuard} accepts it. The caller
 * must also arrange `prisma.marketingUser.findUnique` to return a matching
 * active user (see {@link mockMarketingUser}).
 */
export function signMarketingToken(payload: {
  sub: string;
  wsp: string;
  role?: string;
  ver?: number;
}): string {
  const jwt = new JwtService({
    secret: TEST_ENV.MARKETING_JWT_SECRET,
    signOptions: { algorithm: 'HS256', expiresIn: '8h' },
  });
  return jwt.sign({
    sub: payload.sub,
    wsp: payload.wsp,
    type: 'marketing',
    role: payload.role ?? 'OWNER',
    ver: payload.ver ?? 0,
  });
}

/**
 * Mint a platform-realm operator token the way PlatformAuthService does (HS256
 * over PLATFORM_JWT_SECRET, `type: 'platform'`), so {@link PlatformGuard}
 * accepts it. The caller must arrange `prisma.platformOperator.findUnique` to
 * return a matching ACTIVE operator.
 */
export function signPlatformToken(payload: {
  sub: string;
  ver?: number;
}): string {
  const jwt = new JwtService({
    secret: TEST_ENV.PLATFORM_JWT_SECRET,
    signOptions: { algorithm: 'HS256', expiresIn: '8h' },
  });
  return jwt.sign({ sub: payload.sub, type: 'platform', ver: payload.ver ?? 0 });
}

/** The operator row PlatformGuard re-reads after verifying a token. */
export function mockPlatformOperator(
  over: Partial<Record<string, unknown>> = {},
) {
  return {
    id: 'op-1',
    email: 'operator@example.com',
    name: 'Olga Operator',
    status: 'ACTIVE',
    tokenVersion: 0,
    ...over,
  };
}

/** The user row MarketingGuard re-reads after verifying a token. */
export function mockMarketingUser(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'mu-1',
    workspaceId: 'ws-1',
    email: 'owner@example.com',
    firstName: 'Olive',
    lastName: 'Owner',
    role: 'OWNER',
    status: 'ACTIVE',
    // Epic F — null means "fall back to the legacy role→permission mapping".
    // Specs that exercise custom-role enforcement set this + customRole.findUnique.
    customRoleId: null,
    tokenVersion: 0,
    ...over,
  };
}
