import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import { TokenListInput } from './TokenListInput';

export interface FormField {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: string[];
}

// Must stay in sync with the renderer's whitelist (site-renderer.service.ts).
const FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'radio', 'checkbox', 'date'] as const;
const HAS_OPTIONS = new Set(['select', 'radio', 'checkbox']);

/** Slugify a label into a stable form-field `name` (the POST key). */
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
}

export function FormFieldsEditor({ fields, onChange }: { fields: FormField[]; onChange: (next: FormField[]) => void }) {
  const { t } = useTranslation('marketing');

  const patch = (i: number, p: Partial<FormField>) => onChange(fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  const del = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = () => onChange([...fields, { name: '', label: '', type: 'text', required: false }]);

  return (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={i} className="rounded-lg border border-border p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              className="flex-1"
              placeholder={t('sites.fieldLabel', 'Label (e.g. Full name)')}
              value={f.label ?? ''}
              onChange={(e) => {
                // Auto-derive the name from the label until the user has typed a name.
                const autoName = !f.name || f.name === slugify(f.label ?? '');
                patch(i, { label: e.target.value, ...(autoName ? { name: slugify(e.target.value) } : {}) });
              }}
            />
            <Select value={f.type ?? 'text'} onValueChange={(v) => patch(i, { type: v, ...(HAS_OPTIONS.has(v) && !f.options ? { options: [] } : {}) })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((ty) => <SelectItem key={ty} value={ty}>{ty}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 text-caption text-muted-foreground shrink-0">
              <Switch checked={!!f.required} onCheckedChange={(v) => patch(i, { required: v })} />
              {t('sites.required', 'Req')}
            </label>
            <IconButton variant="ghost" size="sm" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
            <IconButton variant="ghost" size="sm" aria-label="Down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
            <IconButton variant="ghost" size="sm" aria-label="Remove" className="text-danger hover:bg-danger-subtle" onClick={() => del(i)}><Trash2 className="h-4 w-4" /></IconButton>
          </div>
          <div className="flex items-center gap-2">
            <Input
              className="w-48 font-mono text-xs"
              placeholder={t('sites.fieldName', 'name (POST key)')}
              value={f.name}
              onChange={(e) => patch(i, { name: slugify(e.target.value) })}
            />
            {HAS_OPTIONS.has(f.type ?? '') && (
              <TokenListInput
                separator=","
                className="flex-1 text-xs"
                placeholder={t('sites.optionsHint', 'Options, comma-separated')}
                value={Array.isArray(f.options) ? f.options : []}
                onChange={(options) => patch(i, { options })}
              />
            )}
          </div>
        </div>
      ))}
      {fields.length === 0 && (
        <p className="text-caption text-muted-foreground text-center py-3">{t('sites.noFields', 'No fields yet — add one.')}</p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="h-3.5 w-3.5" />{t('sites.addField', 'Add field')}
      </Button>
    </div>
  );
}
