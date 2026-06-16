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
  Textarea,
} from '@/components/ui';
import { courseSchema, type CourseFormValues } from '../schemas';
import type { Course } from '../types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a course to edit, or null to create. */
  course?: Course | null;
  onSubmit: (values: CourseFormValues) => void;
  isPending: boolean;
}

export function CourseFormDialog({ open, onOpenChange, course, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!course;

  const form = useForm<CourseFormValues>({
    resolver: zodResolver(courseSchema),
    mode: 'onBlur',
    defaultValues: { title: '', description: '', price: '', currency: '', coverImageUrl: '' },
  });

  useEffect(() => {
    if (!open) return;
    if (course) {
      form.reset({
        title: course.title,
        description: course.description ?? '',
        price: course.priceCents != null ? String(course.priceCents / 100) : '',
        currency: course.currency ?? '',
        coverImageUrl: course.coverImageUrl ?? '',
      });
    } else {
      form.reset({ title: '', description: '', price: '', currency: '', coverImageUrl: '' });
    }
  }, [course, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`memberships.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<CourseFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('memberships.courses.editTitle', { defaultValue: 'Edit course' })
              : t('memberships.courses.createTitle', { defaultValue: 'New course' })}
          </DialogTitle>
          <DialogDescription>
            {t('memberships.courses.dialogDesc', {
              defaultValue: 'Course details. Add modules and lessons after creating it.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('memberships.courses.titleLabel', { defaultValue: 'Title' })} error={fieldErr(errors.title?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('memberships.courses.titlePlaceholder', { defaultValue: 'e.g. Onboarding 101' })}
                {...form.register('title')}
              />
            )}
          </Field>

          <Field label={t('memberships.courses.description', { defaultValue: 'Description' })} error={fieldErr(errors.description?.message)}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...form.register('description')} />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('memberships.courses.price', { defaultValue: 'Price' })}
              error={fieldErr(errors.price?.message as string | undefined)}
              hint={t('memberships.courses.priceHint', { defaultValue: 'Leave empty for free.' })}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="0.01"
                  min="0"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="0.00"
                  {...form.register('price')}
                />
              )}
            </Field>
            <Field label={t('memberships.courses.currency', { defaultValue: 'Currency' })} error={fieldErr(errors.currency?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="USD" maxLength={8} {...form.register('currency')} />
              )}
            </Field>
          </div>

          <Field label={t('memberships.courses.coverImage', { defaultValue: 'Cover image URL' })} error={fieldErr(errors.coverImageUrl?.message)}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="https://…" {...form.register('coverImageUrl')} />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('memberships.courses.createTitle', { defaultValue: 'New course' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
