import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Textarea } from '@/components/ui/Textarea';
import type { AnyStep } from '../workflowGraph';

interface Props {
  step: AnyStep;
  onReplace: (step: AnyStep) => void;
}

/** Collapsed-by-default power-user escape hatch: edit the selected step's raw
 *  JSON. Valid JSON (a non-null object with a `type`) replaces the step; invalid
 *  JSON shows an inline error and is NOT applied. */
export function AdvancedJsonField({ step, onReplace }: Props) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(step, null, 2));
  const [error, setError] = useState<string | null>(null);

  const onChange = (text: string) => {
    setDraft(text);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.type !== 'string') {
        setError(t('automations.jsonNeedsType', 'Must be a JSON object with a "type" field.'));
        return;
      }
      setError(null);
      onReplace(parsed as AnyStep);
    } catch {
      setError(t('automations.invalidJson', 'Invalid JSON.'));
    }
  };

  return (
    <div className="pt-2 border-t border-border">
      <button
        type="button"
        onClick={() => {
          // Re-sync the draft from the (possibly form-edited) step when opening.
          if (!open) { setDraft(JSON.stringify(step, null, 2)); setError(null); }
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('automations.advancedJson', 'Advanced (JSON)')}
      </button>
      {open && (
        <div className="mt-2">
          <Textarea
            aria-label={t('automations.advancedJson', 'Advanced (JSON)')}
            aria-invalid={!!error}
            className="font-mono text-[11px] min-h-32"
            value={draft}
            onChange={(e) => onChange(e.target.value)}
          />
          {error && <p className="text-[11px] text-danger mt-1">{error}</p>}
        </div>
      )}
    </div>
  );
}
