import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import {
  addCondition, removeCondition, patchCondition, CONDITION_OPS, type Condition,
} from '../builderHelpers';
import type { StepEditorProps } from './types';

/** Visual editor for a `branch` step: a list of (field · operator · value)
 *  conditions plus an optional "else → go to step" jump target. Replaces the old
 *  "switch to JSON" fallback. Writes `filters[]` (and `elseGoto`) via onPatch. */
export function BranchConditionBuilder({ step, onPatch, count }: StepEditorProps) {
  const { t } = useTranslation('marketing');
  const rows = (Array.isArray(step.filters) ? step.filters : []) as Condition[];

  const write = (next: Condition[]) => onPatch({ filters: next });

  return (
    <div className="space-y-2">
      <div className="text-caption text-muted-foreground">
        {t('automations.branchHint', 'Continue when ALL conditions match; otherwise fall through (or jump).')}
      </div>

      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            aria-label={t('automations.condField', 'Field')}
            className="flex-1"
            placeholder="lead.status"
            value={row.field ?? ''}
            onChange={(e) => write(patchCondition(rows, i, { field: e.target.value }))}
          />
          <Select value={row.op ?? 'eq'} onValueChange={(v) => write(patchCondition(rows, i, { op: v }))}>
            <SelectTrigger className="w-24" aria-label={t('automations.condOp', 'Operator')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITION_OPS.map((op) => (
                <SelectItem key={op} value={op}>{op}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label={t('automations.condValue', 'Value')}
            className="flex-1"
            placeholder="NEW"
            value={row.value ?? ''}
            onChange={(e) => write(patchCondition(rows, i, { value: e.target.value }))}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('automations.removeCondition', 'Remove condition')}
            className="text-danger hover:bg-danger-subtle shrink-0"
            onClick={() => write(removeCondition(rows, i))}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={() => write(addCondition(rows))}>
        <Plus className="h-3.5 w-3.5" />
        {t('automations.addCondition', 'Add condition')}
      </Button>

      <div className="pt-2">
        <div className="text-caption text-muted-foreground mb-1">
          {t('automations.elseGoto', 'If no match — go to step # (optional)')}
        </div>
        <Input
          type="number"
          min={1}
          max={count ?? undefined}
          value={typeof step.elseGoto === 'number' ? step.elseGoto + 1 : ''}
          placeholder={t('automations.elseFallThrough', 'fall through')}
          onChange={(e) => {
            const raw = e.target.value;
            // undefined drops the key on serialize (JSON.stringify omits it);
            // UI is 1-based, the DSL stores a 0-based index.
            onPatch({ elseGoto: raw === '' ? undefined : Math.max(0, Math.round(Number(raw)) - 1) });
          }}
        />
      </div>
    </div>
  );
}
