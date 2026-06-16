import { useEffect } from 'react';
import { useForm, useFieldArray, type SubmitHandler } from 'react-hook-form';
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
} from '@/components/ui';
import { experimentSchema, type ExperimentFormValues } from './schemas';
import type { Experiment } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an experiment to edit, or null to create. */
  experiment?: Experiment | null;
  onSubmit: (values: ExperimentFormValues) => void;
  isPending: boolean;
}

const EMPTY: ExperimentFormValues = {
  name: '',
  pageId: '',
  variants: [
    { key: 'a', label: 'Variant A', weight: 1 },
    { key: 'b', label: 'Variant B', weight: 1 },
  ],
};

export function ExperimentFormDialog({ open, onOpenChange, experiment, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!experiment;

  const form = useForm<ExperimentFormValues>({
    resolver: zodResolver(experimentSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'variants' });

  useEffect(() => {
    if (!open) return;
    if (experiment) {
      form.reset({
        name: experiment.name,
        pageId: experiment.pageId ?? '',
        variants:
          experiment.variants?.length >= 1
            ? experiment.variants.map((v) => ({
                key: v.key,
                label: v.label ?? '',
                weight: v.weight ?? 1,
              }))
            : EMPTY.variants,
      });
    } else {
      form.reset(EMPTY);
    }
  }, [experiment, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`experiments.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<ExperimentFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;
  const variantsError = (errors.variants as { message?: string } | undefined)?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('experiments.editTitle', { defaultValue: 'Edit experiment' })
              : t('experiments.createTitle', { defaultValue: 'New A/B experiment' })}
          </DialogTitle>
          <DialogDescription>
            {t('experiments.dialogDesc', {
              defaultValue: 'Split traffic across weighted variants and track conversions per variant.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('experiments.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('experiments.namePlaceholder', { defaultValue: 'e.g. Homepage hero test' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field
            label={t('experiments.pageId', { defaultValue: 'Page ID' })}
            error={fieldErr(errors.pageId?.message)}
            hint={t('experiments.pageIdHint', { defaultValue: 'Optional — the funnel page this experiment runs on.' })}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="page_..."
                {...form.register('pageId')}
              />
            )}
          </Field>

          <Field
            label={t('experiments.variants', { defaultValue: 'Variants' })}
            error={fieldErr(variantsError)}
            hint={t('experiments.variantsHint', { defaultValue: 'At least 2 variants are required to start.' })}
            required
          >
            {() => (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_1fr_88px_36px] items-center gap-2 px-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('experiments.variantKey', { defaultValue: 'Key' })}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('experiments.variantLabel', { defaultValue: 'Label' })}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('experiments.variantWeight', { defaultValue: 'Weight' })}
                  </span>
                  <span />
                </div>
                {fields.map((row, i) => {
                  const keyErr = errors.variants?.[i]?.key?.message as string | undefined;
                  const weightErr = errors.variants?.[i]?.weight?.message as string | undefined;
                  return (
                    <div key={row.id} className="grid grid-cols-[1fr_1fr_88px_36px] items-start gap-2">
                      <div>
                        <Input
                          aria-label={t('experiments.variantKey', { defaultValue: 'Key' })}
                          aria-invalid={!!keyErr}
                          placeholder="a"
                          {...form.register(`variants.${i}.key` as const)}
                        />
                        {keyErr && (
                          <p role="alert" className="mt-1 text-xs text-danger">
                            {fieldErr(keyErr)}
                          </p>
                        )}
                      </div>
                      <Input
                        aria-label={t('experiments.variantLabel', { defaultValue: 'Label' })}
                        placeholder={t('experiments.variantLabel', { defaultValue: 'Label' })}
                        {...form.register(`variants.${i}.label` as const)}
                      />
                      <div>
                        <Input
                          type="number"
                          min={1}
                          aria-label={t('experiments.variantWeight', { defaultValue: 'Weight' })}
                          aria-invalid={!!weightErr}
                          {...form.register(`variants.${i}.weight` as const)}
                        />
                        {weightErr && (
                          <p role="alert" className="mt-1 text-xs text-danger">
                            {fieldErr(weightErr)}
                          </p>
                        )}
                      </div>
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('common.delete', { defaultValue: 'Delete' })}
                        disabled={fields.length <= 2}
                        onClick={() => remove(i)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append({ key: '', label: '', weight: 1 })}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('experiments.addVariant', { defaultValue: 'Add variant' })}
                </Button>
              </div>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('experiments.createTitle', { defaultValue: 'New A/B experiment' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
