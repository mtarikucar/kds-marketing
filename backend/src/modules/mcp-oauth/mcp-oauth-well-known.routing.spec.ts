import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { McpOAuthMetadataController } from './mcp-oauth-metadata.controller';
import { MCP_OAUTH_WELL_KNOWN_EXCLUSIONS } from './mcp-oauth.config';

// `configureApp` builds the real Swagger document, which needs a real app —
// this spec drives it with a stub purely to inspect the setGlobalPrefix call.
jest.mock('../../swagger', () => ({ setupSwagger: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { configureApp } = require('../../app.config');

const BASE = 'https://jeeta.example.com';

/** A stand-in for any ordinary route, to prove the `api` prefix still applies. */
@Controller('marketing/ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

/**
 * RFC 9728 §3 places protected-resource metadata at
 * `/.well-known/oauth-protected-resource` + the resource's path, and RFC 8414
 * §3 places authorization-server metadata at `/.well-known/...` off the
 * issuer — both at the ROOT of the origin. `app.config.ts` sets a global `api`
 * prefix over every route, which would bury them at `/api/.well-known/...`
 * where no client will ever look. This spec locks the exclusion that keeps
 * them at the root, and proves it doesn't disturb ordinary routes.
 */
describe('mcp-oauth well-known routing', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [McpOAuthMetadataController, PingController],
      providers: [{ provide: ConfigService, useValue: { get: () => BASE } }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // EXACTLY what app.config.ts does (locked by the last test in this file).
    app.setGlobalPrefix('api', { exclude: MCP_OAUTH_WELL_KNOWN_EXCLUSIONS });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves protected-resource metadata at the ROOT, not under /api', async () => {
    const ok = await request(app.getHttpServer()).get(
      '/.well-known/oauth-protected-resource/api/mcp',
    );
    expect(ok.status).toBe(200);
    expect(ok.body.resource).toBe(`${BASE}/api/mcp`);

    const prefixed = await request(app.getHttpServer()).get(
      '/api/.well-known/oauth-protected-resource/api/mcp',
    );
    expect(prefixed.status).toBe(404);
  });

  it('serves authorization-server metadata at the ROOT, not under /api', async () => {
    const ok = await request(app.getHttpServer()).get('/.well-known/oauth-authorization-server');
    expect(ok.status).toBe(200);
    expect(ok.body.issuer).toBe(BASE);

    const prefixed = await request(app.getHttpServer()).get(
      '/api/.well-known/oauth-authorization-server',
    );
    expect(prefixed.status).toBe(404);
  });

  it('leaves every ordinary route under the api prefix', async () => {
    await request(app.getHttpServer()).get('/api/marketing/ping').expect(200);
    await request(app.getHttpServer()).get('/marketing/ping').expect(404);
  });

  it('app.config.ts really passes those exclusions to setGlobalPrefix', async () => {
    const setGlobalPrefix = jest.fn();
    const stub = {
      set: jest.fn(),
      use: jest.fn(),
      get: jest.fn(),
      setGlobalPrefix,
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalInterceptors: jest.fn(),
    };
    configureApp(stub as any);
    expect(setGlobalPrefix).toHaveBeenCalledWith('api', {
      exclude: expect.arrayContaining([...MCP_OAUTH_WELL_KNOWN_EXCLUSIONS]),
    });
  });
});
