import { useEffect } from 'react';
import { useForm, Controller, useFieldArray, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  IconButton,
  Field,
  Input,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { customFieldSchema, type CustomFieldFormValues } from '../schemas';
import type { CustomFieldDef, CustomFieldType } from '../types';

const TYPES: { value: CustomFieldType; label: string }[] = [
  { value: 'TEXT', label: 'Text' },
  { value: 'TEXTAREA', label: 'Text area' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'DATE', label: 'Date' },
  { value: 'DATETIME', label: 'Date & time' },
  { value: 'BOOL', label: 'Yes / No' },
  { value: 'SELECT', label: 'Select (single)' },
  { value: 'MULTISELECT', label: 'Multi-select' },
  { value: 'URL', label: 'URL' },
  { value: 'PHONE', label: 'Phone' },
  { value: 'EMAIL', label: 'Email' },
];

const OPTION_TYPES: CustomFieldType[] = ['SELECT', 'MULTISELECT'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a def to edit (key + type become immutable), or null to create. */
  field?: CustomFieldDef | null;
  onSubmit: (values: CustomFieldFormValues) => void;
  isPending: boolean;
}

export function CustomFieldFormDialog({ open, onOpenChange, field, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!field;

  const form = useForm<CustomFieldFormValues>({
    resolver: zodResolver(customFieldSchema),
    mode: 'onBlur',
    defaultValues: { label: '', key: '', type: 'TEXT', options: [], required: false },
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'options' });
  const watchedType = form.watch('type');
  const showOptions = OPTION_TYPES.includes(watchedType);

  useEffect(() => {
    if (!open) return;
    if (field) {
      form.reset({
        label: field.label,
        key: field.key,
        type: field.type,
        options: field.options ?? [],
        required: field.required,
      });
    } else {
      form.reset({ label: '', key: '', type: 'TEXT', options: [], required: false });
    }
  }, [field, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`crm.cf.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<CustomFieldFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('crm.cf.editTitle', { defaultValue: 'Edit custom field' })
              : t('crm.cf.createTitle', { defaultValue: 'New custom field' })}
          </DialogTitle>
          <DialogDescription>
            {t('crm.cf.dialogDesc', {
              defaultValue: 'Custom fields capture workspace-specific data on every lead.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('crm.cf.label', { defaultValue: 'Label' })} error={fieldErr(errors.label?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('crm.cf.labelPlaceholder', { defaultValue: 'e.g. Loyalty tier' })}
                {...form.register('label')}
              />
            )}
          </Field>

          <Field
            label={t('crm.cf.key', { defaultValue: 'Key' })}
            error={fieldErr(errors.key?.message)}
            hint={
              isEdit
                ? t('crm.cf.keyImmutable', { defaultValue: 'The key is immutable once created.' })
                : t('crm.cf.keyHint', { defaultValue: 'Optional. Defaults to a slug of the label. lower_snake_case.' })
            }
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                disabled={isEdit}
                placeholder="loyalty_tier"
                {...form.register('key')}
              />
            )}
          </Field>

          <Field
            label={t('crm.cf.type', { defaultValue: 'Type' })}
            error={fieldErr(errors.type?.message)}
            hint={isEdit ? t('crm.cf.typeImmutable', { defaultValue: 'The type is immutable once created.' }) : undefined}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="type"
                render={({ field: f }) => (
                  <Select value={f.value} onValueChange={f.onChange} disabled={isEdit}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {t(`crm.cf.types.${opt.value}`, { defaultValue: opt.label })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          {showOptions && (
            <Field
              label={t('crm.cf.options', { defaultValue: 'Options' })}
              error={fieldErr((errors.options as { message?: string } | undefined)?.message)}
              required
            >
              {() => (
                <div className="space-y-2">
                  {fields.map((row, i) => (
                    <div key={row.id} className="flex items-start gap-2">
                      <Input
                        aria-label={t('crm.cf.optionValue', { defaultValue: 'Value' })}
                        placeholder={t('crm.cf.optionValue', { defaultValue: 'Value' })}
                        {...form.register(`options.${i}.value` as const)}
                      />
                      <Input
                        aria-label={t('crm.cf.optionLabel', { defaultValue: 'Label' })}
                        placeholder={t('crm.cf.optionLabel', { defaultValue: 'Label' })}
                        {...form.register(`options.${i}.label` as const)}
                      />
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('common.delete', { defaultValue: 'Delete' })}
                        onClick={() => remove(i)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append({ value: '', label: '' })}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t('crm.cf.addOption', { defaultValue: 'Add option' })}
                  </Button>
                </div>
              )}
            </Field>
          )}

          <Controller
            control={form.control}
            name="required"
            render={({ field: f }) => (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('crm.cf.required', { defaultValue: 'Required' })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('crm.cf.requiredHint', { defaultValue: 'Enforced when a lead is created.' })}
                  </p>
                </div>
                <Switch checked={!!f.value} onCheckedChange={f.onChange} />
              </div>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('crm.cf.createTitle', { defaultValue: 'New custom field' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
