import 'reflect-metadata';
import { MarketingAuthController } from './marketing-auth.controller';
import { IS_MARKETING_PUBLIC_KEY } from '../decorators/marketing-public.decorator';

/**
 * no-password-recovery — the two properties of the recovery routes that are
 * decided by decorators rather than by code, and would therefore fail silently.
 *
 * If `forgot-password` ever loses `@MarketingPublic()`, MarketingGuard demands
 * a session for it — and a session is the one thing the locked-out owner this
 * flow exists for does not have. If it loses its `@Throttle`, an
 * unauthenticated route that burns a bcrypt compare (or sends a mail) per call
 * sits on the platform's front door.
 */
describe('MarketingAuthController — password recovery routes', () => {
  const proto = MarketingAuthController.prototype as unknown as Record<string, object>;

  const isPublic = (method: string) =>
    Reflect.getMetadata(IS_MARKETING_PUBLIC_KEY, proto[method]) === true;

  const throttleLimit = (method: string) =>
    Reflect.getMetadata('THROTTLER:LIMITdefault', proto[method]);

  it('forgot-password is reachable without a session', () => {
    expect(isPublic('forgotPassword')).toBe(true);
  });

  it('reset-password is reachable without a session', () => {
    expect(isPublic('resetPassword')).toBe(true);
  });

  it('both are throttled at least as tightly as login', () => {
    const login = throttleLimit('login') as number;
    expect(login).toBeGreaterThan(0);
    expect(throttleLimit('forgotPassword')).toBeLessThanOrEqual(login);
    expect(throttleLimit('resetPassword')).toBeLessThanOrEqual(login);
  });
});
