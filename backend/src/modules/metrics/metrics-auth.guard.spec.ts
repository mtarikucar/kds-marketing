import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MetricsAuthGuard } from './metrics-auth.guard';

const ctxWithHeaders = (headers: Record<string, string>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('MetricsAuthGuard', () => {
  const guard = new MetricsAuthGuard();
  const prev = process.env.METRICS_SCRAPE_TOKEN;
  const prevNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (prev === undefined) delete process.env.METRICS_SCRAPE_TOKEN;
    else process.env.METRICS_SCRAPE_TOKEN = prev;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('allows access when no token is configured (dev / internal-only)', () => {
    delete process.env.METRICS_SCRAPE_TOKEN;
    delete process.env.NODE_ENV;
    expect(guard.canActivate(ctxWithHeaders({}))).toBe(true);
  });

  it('fails CLOSED (503) in production when no token is configured', () => {
    delete process.env.METRICS_SCRAPE_TOKEN;
    process.env.NODE_ENV = 'production';
    expect(() => guard.canActivate(ctxWithHeaders({}))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects when a token is configured but none is presented', () => {
    process.env.METRICS_SCRAPE_TOKEN = 'scrape-secret';
    expect(() => guard.canActivate(ctxWithHeaders({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts a correct Bearer token', () => {
    process.env.METRICS_SCRAPE_TOKEN = 'scrape-secret';
    expect(
      guard.canActivate(ctxWithHeaders({ authorization: 'Bearer scrape-secret' })),
    ).toBe(true);
  });

  it('accepts a correct x-metrics-token header', () => {
    process.env.METRICS_SCRAPE_TOKEN = 'scrape-secret';
    expect(
      guard.canActivate(ctxWithHeaders({ 'x-metrics-token': 'scrape-secret' })),
    ).toBe(true);
  });

  it('rejects a wrong token', () => {
    process.env.METRICS_SCRAPE_TOKEN = 'scrape-secret';
    expect(() =>
      guard.canActivate(ctxWithHeaders({ authorization: 'Bearer nope' })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a token of a different length (constant-time guard prefilter)', () => {
    process.env.METRICS_SCRAPE_TOKEN = 'scrape-secret';
    expect(() =>
      guard.canActivate(ctxWithHeaders({ 'x-metrics-token': 'short' })),
    ).toThrow(UnauthorizedException);
  });
});
