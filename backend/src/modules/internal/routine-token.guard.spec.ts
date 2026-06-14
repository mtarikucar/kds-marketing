import { Logger, UnauthorizedException } from '@nestjs/common';
import { RoutineTokenGuard } from './routine-token.guard';

const ctxWith = (header?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-routine-token': header },
      }),
    }),
  }) as any;

const guard = (token?: string) =>
  new RoutineTokenGuard({ get: () => token } as any);

describe('RoutineTokenGuard', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects when ROUTINE_TOKEN is not configured', () => {
    expect(() => guard(undefined).canActivate(ctxWith('anything'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a missing header', () => {
    expect(() => guard('secret').canActivate(ctxWith(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong-length token', () => {
    expect(() => guard('secret').canActivate(ctxWith('nope'))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a same-length wrong token', () => {
    expect(() => guard('secret').canActivate(ctxWith('xxxxxx'))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the correct token', () => {
    expect(guard('secret').canActivate(ctxWith('secret'))).toBe(true);
  });
});
