import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { setObjectToRows, rowsToSetObject, type SetRow } from '../builderHelpers';
import type { StepEditorProps } from './types';

/** Visual editor for `update_lead`: ordered field→value rows writing the `set`
 *  object. Replaces the old JSON-only fallback. */
export function UpdateLeadEditor({ step, onPatch }: StepEditorProps) {
  const { t } = useTranslation('marketing');
  const rows = setObjectToRows(step.set as Record<string, unknown> | undefined);

  const write = (next: SetRow[]) => onPatch({ set: rowsToSetObject(next) });
  const patchRow = (i: number, patch: Partial<SetRow>) =>
    write(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      <div className="text-caption text-muted-foreground">
        {t('automations.updateLeadHint', 'Set these fields on the lead.')}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            aria-label={t('automations.fieldKey', 'Field')}
            className="flex-1"
            placeholder="status"
            value={row.key}
            onChange={(e) => patchRow(i, { key: e.target.value })}
          />
          <span className="text-muted-foreground">=</span>
          <Input
            aria-label={t('automations.fieldValue', 'Value')}
            className="flex-1"
            placeholder="CONTACTED"
            value={row.value}
            onChange={(e) => patchRow(i, { value: e.target.value })}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('automations.removeField', 'Remove field')}
            className="text-danger hover:bg-danger-subtle shrink-0"
            onClick={() => write(rows.filter((_, idx) => idx !== i))}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => write([...rows, { key: '', value: '' }])}>
        <Plus className="h-3.5 w-3.5" />
        {t('automations.addField', 'Add field')}
      </Button>
    </div>
  );
}
