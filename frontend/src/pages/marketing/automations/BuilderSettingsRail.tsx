import { useTranslation } from 'react-i18next';
import { Sparkles, Plus } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import { TRIGGER_TYPES, STEP_PALETTE } from './constants';
import { STEP_META } from './workflowGraph';

export interface BuilderSettingsRailProps {
  triggerType: string;
  onTriggerChange: (t: string) => void;
  filtersText: string;
  onFiltersTextChange: (v: string) => void;
  filtersError?: string;
  aiPrompt: string;
  onAiPromptChange: (v: string) => void;
  onDraft: () => void;
  drafting: boolean;
  onAddStep: (type: string) => void;
}

/** Left rail of the builder: trigger, trigger-filters, AI-assist, and the
 *  categorized step palette. */
export function BuilderSettingsRail({
  triggerType, onTriggerChange, filtersText, onFiltersTextChange, filtersError,
  aiPrompt, onAiPromptChange, onDraft, drafting, onAddStep,
}: BuilderSettingsRailProps) {
  const { t } = useTranslation('marketing');

  return (
    <div className="w-full shrink-0 space-y-4 overflow-y-auto border-b border-border p-3 md:w-72 md:border-b-0 md:border-r">
      {/* AI assist */}
      <Callout tone="info">
        <div className="mb-1.5 flex items-center gap-1 text-sm font-medium">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {t('automations.aiAssist', 'Describe it — AI drafts the steps')}
        </div>
        <Textarea
          className="min-h-16"
          value={aiPrompt}
          onChange={(e) => onAiPromptChange(e.target.value)}
          placeholder={t('automations.aiPlaceholder', 'e.g. when a new lead comes in, wait 1 hour then send a WhatsApp intro and create a follow-up task')}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2 w-full"
          onClick={onDraft}
          disabled={!aiPrompt.trim() || drafting}
          loading={drafting}
        >
          {t('automations.draftBtn', 'Draft')}
        </Button>
      </Callout>

      {/* Trigger */}
      <div>
        <div className="mb-1 text-caption text-muted-foreground">{t('automations.trigger', 'Trigger')}</div>
        <Select value={triggerType} onValueChange={onTriggerChange}>
          <SelectTrigger aria-label={t('automations.trigger', 'Trigger')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {TRIGGER_TYPES.map((tt) => <SelectItem key={tt} value={tt}>{tt}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Trigger filters (advanced, JSON) */}
      <div>
        <div className="mb-1 text-caption text-muted-foreground">
          {t('automations.filters', 'Trigger filters (JSON, optional)')}
        </div>
        <Textarea
          aria-label={t('automations.filters', 'Trigger filters (JSON, optional)')}
          aria-invalid={!!filtersError}
          className="min-h-16 font-mono text-[11px]"
          value={filtersText}
          onChange={(e) => onFiltersTextChange(e.target.value)}
        />
        {filtersError && <p className="mt-1 text-[11px] text-danger">{filtersError}</p>}
      </div>

      {/* Step palette */}
      <div>
        <div className="mb-1 text-caption text-muted-foreground">{t('automations.addStep', 'Add step')}</div>
        <div className="space-y-2">
          {STEP_PALETTE.map(({ group, types }) => (
            <div key={group}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
              <div className="flex flex-wrap gap-1">
                {types.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => onAddStep(type)}
                    className="flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-surface-muted"
                  >
                    <Plus className="h-3 w-3" />
                    {STEP_META[type]?.label ?? type}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
