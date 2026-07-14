import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Eye } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

/**
 * Shown on every marketing page WHILE an agency OWNER is switched into a
 * sub-account (see AgencyService.accessLocation). A persistent, high-contrast
 * bar so the operator is never confused about which workspace they're acting in,
 * with one click back to the agency console. `agencyReturn` is set only during
 * impersonation and survives F5 (persisted), so the bar re-appears on reload.
 */
export function AgencyImpersonationBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const agencyReturn = useMarketingAuthStore((s) => s.agencyReturn);
  const returnToAgency = useMarketingAuthStore((s) => s.returnToAgency);

  if (!agencyReturn) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm text-amber-950 lg:px-6"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          <span className="font-semibold uppercase tracking-wide">
            {t('agency.impersonation.label', { defaultValue: 'Sub-account' })}
          </span>
          <span aria-hidden="true" className="mx-2 opacity-40">
            •
          </span>
          <span className="font-medium">
            {t('agency.impersonation.banner', {
              defaultValue: 'You are working inside “{{name}}”. Everything you do here affects this sub-account.',
              name: agencyReturn.locationName,
            })}
          </span>
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          returnToAgency();
          qc.clear();
          navigate('/agency/locations');
        }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-950/15 px-3 py-1.5 font-semibold transition-colors hover:bg-amber-950/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-950/60"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        {t('agency.impersonation.return', { defaultValue: 'Return to agency' })}
      </button>
    </div>
  );
}
