import { Logger } from '@nestjs/common';
import { of, throwError, lastValueFrom, catchError } from 'rxjs';
import { HttpLoggingInterceptor } from './http-logging.interceptor';

function ctx(req: any, res: any) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as any;
}

describe('HttpLoggingInterceptor', () => {
  let interceptor: HttpLoggingInterceptor;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    interceptor = new HttpLoggingInterceptor();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs a success line with the request id, method, url and status', async () => {
    const req = { id: 'req-1', method: 'GET', originalUrl: '/api/marketing/leads' };
    const res = { statusCode: 200 };
    const next = { handle: () => of('ok') };

    await lastValueFrom(interceptor.intercept(ctx(req, res), next));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const msg = logSpy.mock.calls[0][0] as string;
    expect(msg).toContain('[req-1]');
    expect(msg).toContain('GET /api/marketing/leads 200');
  });

  it('logs errors at warn', async () => {
    const req = { id: 'req-2', method: 'POST', originalUrl: '/api/x' };
    const res = { statusCode: 500 };
    const next = { handle: () => throwError(() => new Error('boom')) };

    await lastValueFrom(
      interceptor.intercept(ctx(req, res), next).pipe(catchError(() => of(null))),
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('skips health probes (no noise)', async () => {
    const req = { id: 'h', method: 'GET', originalUrl: '/api/health' };
    const next = { handle: () => of('ok') };

    await lastValueFrom(interceptor.intercept(ctx(req, { statusCode: 200 }), next));

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('passes non-http contexts through untouched', () => {
    const next = { handle: jest.fn(() => of('x')) };
    const rpcCtx = { getType: () => 'rpc' } as any;
    interceptor.intercept(rpcCtx, next);
    expect(next.handle).toHaveBeenCalled();
  });
});
