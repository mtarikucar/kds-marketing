import { useQuery } from '@tanstack/react-query';
import marketingApi from '../api/marketingApi';

/** Which factor is armed — `null` when 2FA isn't enabled at all (see TwoFactorService.status). */
export type TwoFactorMethod = 'TOTP' | 'SMS' | null;

export interface TwoFactorStatusResponse {
  enabled: boolean;
  method: TwoFactorMethod;
}

/**
 * Reads GET /marketing/auth/2fa/status. Shares the `['marketing','2fa','status']`
 * query key with TwoFactorPage so both consumers share one cached request.
 *
 * `method` is what tells a phone-number edit whether it needs `currentPassword`
 * re-confirmation (MarketingAuthService.updateProfile only gates SMS-armed
 * accounts, mirroring the `twoFactorEnabled && !twoFactorSecret` backend check).
 */
export function useTwoFactorStatus(enabled: boolean) {
  return useQuery<TwoFactorStatusResponse>({
    queryKey: ['marketing', '2fa', 'status'],
    queryFn: () => marketingApi.get('/auth/2fa/status').then((r) => r.data),
    enabled,
  });
}
