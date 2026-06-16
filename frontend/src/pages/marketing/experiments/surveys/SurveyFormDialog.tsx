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
import { surveySchema, SURVEY_QUESTION_TYPES, type SurveyFormValues } from '../schemas';
import type { Survey } from '../types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a survey to edit, or null to create. */
  survey?: Survey | null;
  onSubmit: (values: SurveyFormValues) => void;
  isPending: boolean;
}

const QUESTION_TYPE_LABELS: Record<(typeof SURVEY_QUESTION_TYPES)[number], string> = {
  TEXT: 'Short text',
  TEXTAREA: 'Long text',
  SINGLE: 'Single choice',
  MULTIPLE: 'Multiple choice',
  RATING: 'Rating',
};

const NEEDS_OPTIONS = (type: string) => type === 'SINGLE' || type === 'MULTIPLE';

const EMPTY: SurveyFormValues = {
  name: '',
  redirectUrl: '',
  questions: [{ key: 'q1', label: '', type: 'TEXT', required: false, options: '' }],
};

export function SurveyFormDialog({ open, onOpenChange, survey, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!survey;

  const form = useForm<SurveyFormValues>({
    resolver: zodResolver(surveySchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'questions' });

  useEffect(() => {
    if (!open) return;
    if (survey) {
      form.reset({
        name: survey.name,
        redirectUrl: survey.redirectUrl ?? '',
        questions:
          survey.questions?.length >= 1
            ? survey.questions.map((q) => ({
                key: q.key,
                label: q.label,
                type: q.type,
                required: !!q.required,
                options: (q.options ?? []).join(', '),
              }))
            : EMPTY.questions,
      });
    } else {
      form.reset(EMPTY);
    }
  }, [survey, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`surveys.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<SurveyFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;
  const questionsError = (errors.questions as { message?: string } | undefined)?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('surveys.editTitle', { defaultValue: 'Edit survey' })
              : t('surveys.createTitle', { defaultValue: 'New survey' })}
          </DialogTitle>
          <DialogDescription>
            {t('surveys.dialogDesc', {
              defaultValue: 'Build a survey with questions, then publish it to start collecting responses.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('surveys.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('surveys.namePlaceholder', { defaultValue: 'e.g. Post-purchase feedback' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field
            label={t('surveys.redirectUrl', { defaultValue: 'Redirect URL' })}
            error={fieldErr(errors.redirectUrl?.message)}
            hint={t('surveys.redirectUrlHint', { defaultValue: 'Optional — where to send respondents after submitting.' })}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="https://example.com/thank-you"
                {...form.register('redirectUrl')}
              />
            )}
          </Field>

          <Field
            label={t('surveys.questions', { defaultValue: 'Questions' })}
            error={fieldErr(questionsError)}
            required
          >
            {() => (
              <div className="space-y-3">
                {fields.map((row, i) => {
                  const qErrors = errors.questions?.[i];
                  const type = form.watch(`questions.${i}.type`);
                  return (
                    <div key={row.id} className="space-y-2 rounded-lg border border-border p-3">
                      <div className="flex items-start gap-2">
                        <div className="w-28 shrink-0">
                          <Input
                            aria-label={t('surveys.questionKey', { defaultValue: 'Key' })}
                            aria-invalid={!!qErrors?.key}
                            placeholder="q1"
                            {...form.register(`questions.${i}.key` as const)}
                          />
                          {qErrors?.key?.message && (
                            <p role="alert" className="mt-1 text-xs text-danger">
                              {fieldErr(qErrors.key.message as string)}
                            </p>
                          )}
                        </div>
                        <div className="flex-1">
                          <Input
                            aria-label={t('surveys.questionLabel', { defaultValue: 'Question' })}
                            aria-invalid={!!qErrors?.label}
                            placeholder={t('surveys.questionLabelPlaceholder', { defaultValue: 'How was your experience?' })}
                            {...form.register(`questions.${i}.label` as const)}
                          />
                          {qErrors?.label?.message && (
                            <p role="alert" className="mt-1 text-xs text-danger">
                              {fieldErr(qErrors.label.message as string)}
                            </p>
                          )}
                        </div>
                        <IconButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('common.delete', { defaultValue: 'Delete' })}
                          disabled={fields.length <= 1}
                          onClick={() => remove(i)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="w-44">
                          <Controller
                            control={form.control}
                            name={`questions.${i}.type` as const}
                            render={({ field }) => (
                              <Select value={field.value} onValueChange={field.onChange}>
                                <SelectTrigger aria-label={t('surveys.questionType', { defaultValue: 'Type' })}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {SURVEY_QUESTION_TYPES.map((opt) => (
                                    <SelectItem key={opt} value={opt}>
                                      {t(`surveys.types.${opt}`, { defaultValue: QUESTION_TYPE_LABELS[opt] })}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </div>
                        <Controller
                          control={form.control}
                          name={`questions.${i}.required` as const}
                          render={({ field }) => (
                            <label className="flex items-center gap-2 text-sm text-foreground">
                              <Switch checked={!!field.value} onCheckedChange={field.onChange} />
                              {t('surveys.required', { defaultValue: 'Required' })}
                            </label>
                          )}
                        />
                      </div>

                      {NEEDS_OPTIONS(type) && (
                        <div>
                          <Input
                            aria-label={t('surveys.options', { defaultValue: 'Options' })}
                            aria-invalid={!!qErrors?.options}
                            placeholder={t('surveys.optionsPlaceholder', { defaultValue: 'Comma-separated, e.g. Yes, No, Maybe' })}
                            {...form.register(`questions.${i}.options` as const)}
                          />
                          {qErrors?.options?.message && (
                            <p role="alert" className="mt-1 text-xs text-danger">
                              {fieldErr(qErrors.options.message as string)}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({ key: `q${fields.length + 1}`, label: '', type: 'TEXT', required: false, options: '' })
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('surveys.addQuestion', { defaultValue: 'Add question' })}
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
                : t('surveys.createTitle', { defaultValue: 'New survey' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
