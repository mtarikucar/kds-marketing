import { useTranslation } from 'react-i18next';
import { ArrowLeft, Play, Pause } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

export interface BuilderTopBarProps {
  name: string;
  onNameChange: (name: string) => void;
  status: string; // ACTIVE | PAUSED | DRAFT | '' (new)
  /** True for an existing workflow (enables Activate/Pause). */
  canToggle: boolean;
  saving: boolean;
  /** Block Save when the builder has an unresolved error (e.g. invalid trigger
   *  filters JSON) — otherwise a save would silently persist stale state. */
  saveDisabled?: boolean;
  onBack: () => void;
  onSave: () => void;
  onToggleStatus: () => void;
}

function statusTone(status: string) {
  if (status === 'ACTIVE') return 'success' as const;
  if (status === 'PAUSED') return 'warning' as const;
  return 'neutral' as const;
}

/** Sticky builder header: back, inline name, status, Save, Activate/Pause. */
export function BuilderTopBar({
  name, onNameChange, status, canToggle, saving, saveDisabled, onBack, onSave, onToggleStatus,
}: BuilderTopBarProps) {
  const { t } = useTranslation('marketing');
  const isActive = status === 'ACTIVE';

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-border bg-surface/95 px-4 py-2.5 backdrop-blur sm:gap-3">
      <IconButton variant="ghost" size="sm" aria-label={t('common.back', 'Back')} onClick={onBack}>
        <ArrowLeft className="h-5 w-5" />
      </IconButton>
      <Input
        aria-label={t('automations.name', 'Name')}
        className="min-w-0 flex-1 font-medium md:max-w-sm md:flex-none"
        placeholder={t('automations.namePlaceholder', 'Automation name')}
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
      />
      {status && <Badge tone={statusTone(status)} size="sm">{status}</Badge>}
      <div className="flex-1" />
      {canToggle && (
        <Button variant="outline" size="sm" onClick={onToggleStatus}>
          {isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {isActive ? t('automations.pause', 'Pause') : t('automations.activate', 'Activate')}
        </Button>
      )}
      <Button size="sm" onClick={onSave} loading={saving} disabled={saving || saveDisabled}>
        {t('common.save', 'Save')}
      </Button>
    </div>
  );
}
