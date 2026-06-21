import { useEffect } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
} from '@/components/ui';
import type { CustomObjectDef } from '../../../features/marketing/api/custom-objects.service';

const schema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'required')
    .max(64, 'tooLong')
    .regex(/^[a-z][a-z0-9_]*$/, 'lowerSnakeCase'),
  labelSingular: z.string().trim().min(1, 'required').max(80, 'tooLong'),
  labelPlural: z.string().trim().min(1, 'required').max(80, 'tooLong'),
  primaryField: z.string().trim().max(64, 'tooLong').optional().or(z.literal('')),
  description: z.string().trim().max(500, 'tooLong').optional().or(z.literal('')),
});

export type ObjectFormValues = z.infer<typeof schema>;

interface ObjectFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  object: CustomObjectDef | null;
  onSubmit: (values: ObjectFormValues) => void;
  isPending: boolean;
}

export function ObjectFormDialog({ open, onOpenChange, object, onSubmit, isPending }: ObjectFormDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!object;

  const form = useForm<ObjectFormValues>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { key: '', labelSingular: '', labelPlural: '', primaryField: 'name', description: '' },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      object
        ? {
            key: object.key,
            labelSingular: object.labelSingular,
            labelPlural: object.labelPlural,
            primaryField: object.primaryField,
            description: object.description ?? '',
          }
        : { key: '', labelSingular: '', labelPlural: '', primaryField: 'name', description: '' },
    );
  }, [open, object, form]);

  const fieldErr = (msg?: string) => (msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined);
  const errors = form.formState.errors;

  const handleSubmit: SubmitHandler<ObjectFormValues> = (values) =>
    onSubmit({
      ...values,
      primaryField: values.primaryField?.trim() || 'name',
      description: values.description?.trim() || undefined,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('customObjects.form.editTitle', { defaultValue: 'Edit object' })
              : t('customObjects.form.newTitle', { defaultValue: 'New custom object' })}
          </DialogTitle>
          <DialogDescription>
            {t('customObjects.form.subtitle', {
              defaultValue: 'Define a record type for your workspace (e.g. Property, Vehicle, Policy).',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('customObjects.form.key', { defaultValue: 'Key' })}
            hint={t('customObjects.form.keyHint', { defaultValue: 'Immutable lower_snake_case identifier.' })}
            error={fieldErr(errors.key?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="property"
                disabled={isEdit}
                {...form.register('key')}
              />
            )}
          </Field>

          <Field
            label={t('customObjects.form.labelSingular', { defaultValue: 'Name (singular)' })}
            error={fieldErr(errors.labelSingular?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="Property" {...form.register('labelSingular')} />
            )}
          </Field>

          <Field
            label={t('customObjects.form.labelPlural', { defaultValue: 'Name (plural)' })}
            error={fieldErr(errors.labelPlural?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="Properties" {...form.register('labelPlural')} />
            )}
          </Field>

          <Field
            label={t('customObjects.form.primaryField', { defaultValue: 'Primary field key' })}
            hint={t('customObjects.form.primaryFieldHint', {
              defaultValue: 'Which field key is the record’s display name (default "name").',
            })}
            error={fieldErr(errors.primaryField?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="name" {...form.register('primaryField')} />
            )}
          </Field>

          <Field
            label={t('customObjects.form.description', { defaultValue: 'Description' })}
            error={fieldErr(errors.description?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('description')} />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('common.create', { defaultValue: 'Create' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
