import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import marketingApi from '../api/marketingApi';

type Strategy = 'DISABLED' | 'ROUND_ROBIN' | 'LEAST_LOADED';

interface DistributionConfig {
  id: string;
  strategy: Strategy;
  lastAssignedToId?: string | null;
  lastAssignedTo?: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  updatedAt: string;
}

const STRATEGIES: Strategy[] = ['DISABLED', 'ROUND_ROBIN', 'LEAST_LOADED'];

/**
 * Manager-only card on the Sales Team page that controls how new
 * leads are auto-assigned. Co-located with the team list so the
 * manager sees the strategy + the pool of reps it operates on in one
 * place.
 */
export default function DistributionConfigCard() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [strategy, setStrategy] = useState<Strategy>('DISABLED');
  const [dirty, setDirty] = useState(false);

  const { data: cfg, isLoading } = useQuery<DistributionConfig>({
    queryKey: ['marketing', 'distribution-config'],
    queryFn: () => marketingApi.get('/distribution-config').then((r) => r.data),
  });

  // Reset local state when the server value loads or changes — so
  // discarding edits is just a page reload.
  useEffect(() => {
    if (cfg?.strategy) {
      setStrategy(cfg.strategy);
      setDirty(false);
    }
  }, [cfg?.strategy]);

  const save = useMutation({
    mutationFn: (next: Strategy) =>
      marketingApi.patch('/distribution-config', { strategy: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'distribution-config'] });
      setDirty(false);
      toast.success(t('distribution.saveSuccess'));
    },
    onError: () => toast.error(t('distribution.saveError')),
  });

  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t('distribution.title')}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('distribution.subtitle')}
          </p>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <>
          <div className="space-y-2">
            {STRATEGIES.map((s) => (
              <label
                key={s}
                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border transition-colors ${
                  strategy === s
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border hover:bg-surface-muted'
                }`}
              >
                <input
                  type="radio"
                  name="distribution-strategy"
                  value={s}
                  checked={strategy === s}
                  onChange={() => {
                    setStrategy(s);
                    setDirty(s !== cfg?.strategy);
                  }}
                  className="text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">
                  {t(`distribution.strategy.${s}`)}
                </span>
              </label>
            ))}
          </div>

          {cfg?.lastAssignedTo && cfg.strategy === 'ROUND_ROBIN' && (
            <p className="text-xs text-muted-foreground mt-3">
              {t('distribution.lastAssignedTo')}:{' '}
              <span className="text-foreground">
                {cfg.lastAssignedTo.firstName} {cfg.lastAssignedTo.lastName}
              </span>
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => save.mutate(strategy)}
              disabled={!dirty || save.isPending}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {save.isPending ? t('common.loading') : t('distribution.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
