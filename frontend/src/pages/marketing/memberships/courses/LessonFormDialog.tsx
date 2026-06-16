import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
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
  Textarea,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { lessonSchema, type LessonFormValues } from '../schemas';
import type { Lesson, LessonType } from '../types';

const TYPES: { value: LessonType; label: string }[] = [
  { value: 'VIDEO', label: 'Video' },
  { value: 'TEXT', label: 'Text' },
  { value: 'PDF', label: 'PDF' },
  { value: 'QUIZ', label: 'Quiz' },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lesson?: Lesson | null;
  onSubmit: (values: LessonFormValues) => void;
  isPending: boolean;
}

export function LessonFormDialog({ open, onOpenChange, lesson, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!lesson;

  const form = useForm<LessonFormValues>({
    resolver: zodResolver(lessonSchema),
    mode: 'onBlur',
    defaultValues: { title: '', type: 'VIDEO', content: '', videoUrl: '', durationSec: '', isPreview: false },
  });

  const watchedType = form.watch('type');

  useEffect(() => {
    if (!open) return;
    if (lesson) {
      form.reset({
        title: lesson.title,
        type: lesson.type,
        content: lesson.content ?? '',
        videoUrl: lesson.videoUrl ?? '',
        durationSec: lesson.durationSec != null ? String(lesson.durationSec) : '',
        isPreview: lesson.isPreview,
      });
    } else {
      form.reset({ title: '', type: 'VIDEO', content: '', videoUrl: '', durationSec: '', isPreview: false });
    }
  }, [lesson, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`memberships.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<LessonFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('memberships.lessons.editTitle', { defaultValue: 'Edit lesson' })
              : t('memberships.lessons.createTitle', { defaultValue: 'New lesson' })}
          </DialogTitle>
          <DialogDescription>
            {t('memberships.lessons.dialogDesc', { defaultValue: 'A lesson is the smallest unit of a course.' })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('memberships.lessons.titleLabel', { defaultValue: 'Title' })} error={fieldErr(errors.title?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('title')} />
            )}
          </Field>

          <Field label={t('memberships.lessons.type', { defaultValue: 'Type' })} error={fieldErr(errors.type?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="type"
                render={({ field: f }) => (
                  <Select value={f.value} onValueChange={f.onChange}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {t(`memberships.lessons.types.${opt.value}`, { defaultValue: opt.label })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          {watchedType === 'VIDEO' && (
            <Field label={t('memberships.lessons.videoUrl', { defaultValue: 'Video URL' })} error={fieldErr(errors.videoUrl?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="https://…" {...form.register('videoUrl')} />
              )}
            </Field>
          )}

          {(watchedType === 'TEXT' || watchedType === 'QUIZ') && (
            <Field label={t('memberships.lessons.content', { defaultValue: 'Content' })} error={fieldErr(errors.content?.message)}>
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={4} {...form.register('content')} />
              )}
            </Field>
          )}

          <Field
            label={t('memberships.lessons.duration', { defaultValue: 'Duration (seconds)' })}
            error={fieldErr(errors.durationSec?.message as string | undefined)}
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="number" min="0" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('durationSec')} />
            )}
          </Field>

          <Controller
            control={form.control}
            name="isPreview"
            render={({ field: f }) => (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">{t('memberships.lessons.preview', { defaultValue: 'Free preview' })}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('memberships.lessons.previewHint', { defaultValue: 'Accessible without enrolling.' })}
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
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('memberships.lessons.createTitle', { defaultValue: 'New lesson' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
