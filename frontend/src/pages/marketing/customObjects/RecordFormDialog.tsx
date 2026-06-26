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
  EmptyState,
} from '@/components/ui';
import type { CustomObjectRecord } from '../../../features/marketing/api/custom-objects.service';
import type { CustomFieldDef } from '../crm/types';
import { CustomFieldValueInput, seedCustomFieldValues } from '../crm/CustomFieldValueInput';

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
    if (open) setValues(seedCustomFieldValues(fields, record?.values));
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
                  <CustomFieldValueInput
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
