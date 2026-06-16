import { useEffect } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
} from '@/components/ui';
import { tagSchema, type TagFormValues } from '../schemas';
import type { MarketingTag } from '../types';

const SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag?: MarketingTag | null;
  onSubmit: (values: TagFormValues) => void;
  isPending: boolean;
}

export function TagFormDialog({ open, onOpenChange, tag, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!tag;

  const form = useForm<TagFormValues>({
    resolver: zodResolver(tagSchema),
    mode: 'onBlur',
    defaultValues: { name: '', color: '' },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({ name: tag?.name ?? '', color: tag?.color ?? '' });
  }, [tag, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`crm.tags.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<TagFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;
  const color = form.watch('color');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('crm.tags.editTitle', { defaultValue: 'Edit tag' })
              : t('crm.tags.createTitle', { defaultValue: 'New tag' })}
          </DialogTitle>
          <DialogDescription>
            {t('crm.tags.dialogDesc', { defaultValue: 'Tags let you label and segment leads.' })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('crm.tags.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('crm.tags.namePlaceholder', { defaultValue: 'e.g. VIP' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field
            label={t('crm.tags.color', { defaultValue: 'Color' })}
            error={fieldErr(errors.color?.message)}
            hint={t('crm.tags.colorHint', { defaultValue: 'Optional. Hex colour, e.g. #6366f1.' })}
          >
            {({ id, describedBy, invalid }) => (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {SWATCHES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      onClick={() => form.setValue('color', c, { shouldValidate: true })}
                      className="h-6 w-6 rounded-full ring-offset-2 ring-offset-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      style={{ backgroundColor: c, boxShadow: color === c ? '0 0 0 2px var(--ring)' : undefined }}
                    />
                  ))}
                </div>
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="#6366f1"
                  {...form.register('color')}
                />
              </div>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('crm.tags.createTitle', { defaultValue: 'New tag' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
