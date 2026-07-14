import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
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
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950 lg:px-6">
      <span className="min-w-0 truncate">
        {t('agency.impersonation.banner', {
          defaultValue: 'You are inside the sub-account “{{name}}”.',
          name: agencyReturn.locationName,
        })}
      </span>
      <button
        type="button"
        onClick={() => {
          returnToAgency();
          qc.clear();
          navigate('/agency/locations');
        }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-950/10 px-2.5 py-1 font-semibold hover:bg-amber-950/20"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        {t('agency.impersonation.return', { defaultValue: 'Return to agency' })}
      </button>
    </div>
  );
}
