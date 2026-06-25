import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Input,
  Textarea,
  Switch,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  EmptyState,
} from '@/components/ui';
import type { CustomFieldDef } from '../crm/types';
import type { CustomObjectRecord } from '../../../features/marketing/api/custom-objects.service';

interface RecordFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: CustomFieldDef[];
  record: CustomObjectRecord | null;
  objectLabel: string;
  onSubmit: (values: Record<string, unknown>) => void;
  isPending: boolean;
}

/**
 * Dynamic record form: one input per active field def, rendered by field type.
 * Values are kept as a plain map and sent verbatim — the backend validates and
 * coerces against the object's field defs (single source of truth), so this
 * form stays declarative and never duplicates the coercion rules.
 */
export function RecordFormDialog({
  open,
  onOpenChange,
  fields,
  record,
  objectLabel,
  onSubmit,
  isPending,
}: RecordFormDialogProps) {
  const { t } = useTranslation('marketing');
  const active = fields.filter((f) => !f.archived);
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!open) return;
    const base: Record<string, unknown> = record ? { ...record.values } : {};
    // A required BOOL the user never toggles stays `undefined`, which the
    // backend rejects as "required" — so a record whose only unset required
    // field is a BOOL the user wants OFF can never be saved. Seed BOOLs to
    // `false` so "off" is a real, submittable value.
    for (const f of fields) {
      if (f.type === 'BOOL' && base[f.key] === undefined) base[f.key] = false;
    }
    setValues(base);
  }, [open, record, fields]);

  const set = (key: string, v: unknown) => setValues((prev) => ({ ...prev, [key]: v }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {record
              ? t('customObjects.record.editTitle', { defaultValue: 'Edit {{label}}', label: objectLabel })
              : t('customObjects.record.newTitle', { defaultValue: 'New {{label}}', label: objectLabel })}
          </DialogTitle>
          <DialogDescription>
            {t('customObjects.record.subtitle', { defaultValue: 'Fill in the fields for this record.' })}
          </DialogDescription>
        </DialogHeader>

        {active.length === 0 ? (
          <EmptyState
            title={t('customObjects.record.noFields', { defaultValue: 'No fields defined' })}
            description={t('customObjects.record.noFieldsHint', {
              defaultValue: 'Add fields to this object before creating records.',
            })}
          />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {active.map((f) => (
              <Field key={f.id} label={f.label} required={f.required}>
                {({ id, describedBy, invalid }) => (
                  <RecordFieldInput
                    field={f}
                    value={values[f.key]}
                    onChange={(v) => set(f.key, v)}
                    id={id}
                    describedBy={describedBy}
                    invalid={invalid}
                  />
                )}
              </Field>
            ))}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button type="submit" loading={isPending}>
                {t('common.save', { defaultValue: 'Save' })}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface FieldInputProps {
  field: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  describedBy?: string;
  invalid?: boolean;
}

function RecordFieldInput({ field, value, onChange, id, describedBy, invalid }: FieldInputProps) {
  const common = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid };

  switch (field.type) {
    case 'TEXTAREA':
      return (
        <Textarea {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />
      );
    case 'NUMBER':
      return (
        <Input
          {...common}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'DATE':
      return (
        <Input
          {...common}
          type="date"
          value={(value as string)?.slice(0, 10) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case 'DATETIME':
      return (
        <Input
          {...common}
          type="datetime-local"
          value={(value as string)?.slice(0, 16) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case 'BOOL':
      return <Switch checked={!!value} onCheckedChange={onChange} />;
    case 'SELECT':
      return (
        <Select value={(value as string) ?? ''} onValueChange={onChange}>
          <SelectTrigger {...common}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'MULTISELECT': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const toggle = (v: string, on: boolean) =>
        onChange(on ? [...arr, v] : arr.filter((x) => x !== v));
      return (
        <div className="space-y-1.5">
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <Checkbox checked={arr.includes(o.value)} onCheckedChange={(c) => toggle(o.value, !!c)} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    default:
      // TEXT, PHONE, EMAIL, URL
      return (
        <Input
          {...common}
          type={field.type === 'EMAIL' ? 'email' : field.type === 'URL' ? 'url' : 'text'}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
