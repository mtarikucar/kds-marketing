import { ArrowRight, MessageSquare, Monitor, Phone, Send, Layers, Megaphone, Briefcase, Blocks } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Disclosure, cn } from '@/components/ui';
import { kindLabel } from '@/lib/capabilities';
import { CAPABILITY_GOALS, GOAL_CONNECTIONS, type CapabilityGoal } from '@/lib/capabilityGoals';
import { useAbilityCopy } from './abilityCopy';

const icons = {
  all: Layers,
  messages: MessageSquare,
  publishing: Send,
  calls: Phone,
  devices: Monitor,
  growth: Megaphone,
  tools: Briefcase,
  custom: Blocks,
};
export function PurposePanel({
  goal,
  onChange,
  canManage,
  canPair,
  onDevices,
  onDeclare,
}: {
  goal: CapabilityGoal;
  onChange: (goal: CapabilityGoal) => void;
  canManage: boolean;
  canPair: boolean;
  onDevices: () => void;
  onDeclare: () => void;
}) {
  const { t } = useTranslation();
  const copy = useAbilityCopy();
  const label = (value: CapabilityGoal) => value === 'custom' ? copy('customGoal') : value === 'all' ? copy('allAbilities') : t(`capabilities.workbench.goals.${value}.label`);
  return (
    <section className="space-y-4" aria-label={t('capabilities.workbench.purposeLabel')}>
      <label className="block text-sm font-medium md:hidden">
        {t('capabilities.workbench.purposeLabel')}
        <select
          aria-label={t('capabilities.workbench.purposeLabel')}
          className="mt-2 h-11 w-full rounded-md border border-input bg-surface px-3"
          value={goal}
          onChange={(e) => onChange(e.target.value as CapabilityGoal)}
        >
          {CAPABILITY_GOALS.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </label>
      <div
        className="hidden flex-wrap gap-1 border-b border-border pb-3 md:flex"
        role="group"
        aria-label={t('capabilities.workbench.purposeLabel')}
      >
        {CAPABILITY_GOALS.map((value) => {
          const Icon = icons[value];
          return (
            <button
              key={value}
              type="button"
              aria-pressed={goal === value}
              onClick={() => onChange(value)}
              className={cn(
                'flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                goal === value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label(value)}
            </button>
          );
        })}
      </div>
      {goal !== 'all' && (
        <div className="min-w-0 border-s-2 border-primary/30 ps-4">
          <h3 className="text-base font-medium">{goal === 'custom' ? copy('customGoalTitle') : t(`capabilities.workbench.goals.${goal}.title`)}</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {goal === 'custom' ? copy('customGoalBody') : t(`capabilities.workbench.goals.${goal}.description`)}
          </p>
          {canManage || (goal === 'devices' && canPair) ? (
            <div className="mt-3">
              <Disclosure title={t('capabilities.workbench.addForPurpose')}>
                <div className="flex flex-wrap gap-2 py-2">
                  {GOAL_CONNECTIONS[goal].map((kind) => (
                    <Button key={kind} asChild variant="outline">
                      <Link to={`/connect?kind=${kind}`}>
                        {kindLabel(t, kind)}
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </Button>
                  ))}
                  {goal === 'devices' && canPair && (
                    <Button variant="outline" onClick={onDevices}>
                      {t('capabilities.workbench.pairDevice')}
                    </Button>
                  )}
                  {canManage && (goal === 'devices' || goal === 'tools' || goal === 'growth' || goal === 'custom') && (
                    <Button variant="outline" onClick={onDeclare}>
                      {goal === 'custom' ? copy('custom') : t('capabilities.declare')}
                    </Button>
                  )}
                </div>
              </Disclosure>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{t('capabilities.workbench.managerNeeded')}</p>
          )}
        </div>
      )}
    </section>
  );
}
