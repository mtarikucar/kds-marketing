import { Logger, UnauthorizedException } from '@nestjs/common';
import { ResearchRoutineTokenGuard } from './research-routine-token.guard';

/**
 * The external research routine is a CROSS-WORKSPACE surface: one token reads
 * every active workspace's work-list and writes leads into any of them. The
 * only thing standing in front of it is this guard, so its failure modes are
 * the security contract:
 *
 *   - unconfigured secret  → fail CLOSED (never "no token configured = allow")
 *   - missing / wrong token → 401
 *   - compare in constant time (no early-exit on the first differing byte)
 *   - a DIFFERENT routine's credential must not open this door
 */

const ctxWith = (header?: string | string[]) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-research-token': header },
      }),
    }),
  }) as any;

const guard = (token?: string, key = 'RESEARCH_ROUTINE_TOKEN') =>
  new ResearchRoutineTokenGuard({
    get: (k: string) => (k === key ? token : undefined),
  } as any);

describe('ResearchRoutineTokenGuard', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('fails closed when RESEARCH_ROUTINE_TOKEN is unset', () => {
    it('rejects even a well-formed call when the secret is not configured', () => {
      expect(() => guard(undefined).canActivate(ctxWith('anything'))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a no-header call when the secret is not configured', () => {
      expect(() => guard(undefined).canActivate(ctxWith(undefined))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects when the secret is configured to an empty string', () => {
      expect(() => guard('').canActivate(ctxWith(''))).toThrow(
        UnauthorizedException,
      );
    });

    it('never returns true for ANY header value while unconfigured', () => {
      const g = guard(undefined);
      for (const h of ['', 'x', 'undefined', 'null', 'true']) {
        expect(() => g.canActivate(ctxWith(h))).toThrow(UnauthorizedException);
      }
    });
  });

  describe('token validation', () => {
    it('rejects a missing header', () => {
      expect(() => guard('secret').canActivate(ctxWith(undefined))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an empty header', () => {
      expect(() => guard('secret').canActivate(ctxWith(''))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a repeated header (express hands back an array, not a string)', () => {
      expect(() =>
        guard('secret').canActivate(ctxWith(['secret', 'secret'])),
      ).toThrow(UnauthorizedException);
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

    it('rejects a token that is a strict PREFIX of the expected one', () => {
      expect(() => guard('secret').canActivate(ctxWith('secr'))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token that merely STARTS WITH the expected one', () => {
      expect(() => guard('secret').canActivate(ctxWith('secretly'))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a same-length token differing only in the LAST byte (no early exit)', () => {
      expect(() => guard('secret').canActivate(ctxWith('secreT'))).toThrow(
        UnauthorizedException,
      );
    });

    it('accepts the correct token', () => {
      expect(guard('secret').canActivate(ctxWith('secret'))).toBe(true);
    });
  });

  describe('principal separation', () => {
    it('reads ONLY RESEARCH_ROUTINE_TOKEN, so ROUTINE_TOKEN cannot open this door', () => {
      const get = jest.fn().mockReturnValue(undefined);
      const g = new ResearchRoutineTokenGuard({ get } as any);
      expect(() => g.canActivate(ctxWith('the-routine-token'))).toThrow(
        UnauthorizedException,
      );
      expect(get).toHaveBeenCalledWith('RESEARCH_ROUTINE_TOKEN');
      expect(get).not.toHaveBeenCalledWith('ROUTINE_TOKEN');
      expect(get).not.toHaveBeenCalledWith('INTERNAL_SERVICE_TOKEN');
    });

    it('rejects the sibling routine credential even when both are configured', () => {
      // Deliberately the SAME length, so the rejection comes from the compare
      // and not from the cheap length guard.
      const g = new ResearchRoutineTokenGuard({
        get: (k: string) =>
          k === 'RESEARCH_ROUTINE_TOKEN' ? 'research-secret' : 'routine-secretX',
      } as any);
      expect(() => g.canActivate(ctxWith('routine-secretX'))).toThrow(
        UnauthorizedException,
      );
      expect(g.canActivate(ctxWith('research-secret'))).toBe(true);
    });
  });
});
