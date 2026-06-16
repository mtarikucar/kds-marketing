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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui';
import { captureSnapshotSchema, type CaptureSnapshotFormValues } from './schemas';
import type { Location } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Child locations the snapshot can be captured FROM (besides the agency itself). */
  locations: Location[];
  onSubmit: (values: CaptureSnapshotFormValues) => void;
  isPending: boolean;
}

const AGENCY_SOURCE = '__agency__';

export function CaptureSnapshotDialog({ open, onOpenChange, locations, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');

  const form = useForm<CaptureSnapshotFormValues>({
    resolver: zodResolver(captureSnapshotSchema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '', sourceWorkspaceId: '' },
  });

  useEffect(() => {
    if (open) form.reset({ name: '', description: '', sourceWorkspaceId: '' });
  }, [open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`agency.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<CaptureSnapshotFormValues> = (values) => {
    const payload: CaptureSnapshotFormValues = { name: values.name };
    if (values.description) payload.description = values.description;
    // Empty / agency sentinel → omit so the backend defaults to the agency itself.
    if (values.sourceWorkspaceId) payload.sourceWorkspaceId = values.sourceWorkspaceId;
    onSubmit(payload);
  };
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('agency.snapshots.captureTitle', { defaultValue: 'Capture snapshot' })}</DialogTitle>
          <DialogDescription>
            {t('agency.snapshots.captureDesc', {
              defaultValue: 'Capture a source workspace’s configuration (custom fields, tags, workflows, pages…) into a reusable snapshot. Customer data is never captured.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('agency.snapshots.name', { defaultValue: 'Snapshot name' })} error={fieldErr(errors.name?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder={t('agency.snapshots.namePlaceholder', { defaultValue: 'e.g. Dental starter config' })} {...form.register('name')} />
            )}
          </Field>

          <Field label={t('agency.snapshots.description', { defaultValue: 'Description' })} error={fieldErr(errors.description?.message)}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={2} {...form.register('description')} />
            )}
          </Field>

          <Field
            label={t('agency.snapshots.source', { defaultValue: 'Capture from' })}
            error={fieldErr(errors.sourceWorkspaceId?.message)}
            hint={t('agency.snapshots.sourceHint', { defaultValue: 'The agency workspace itself, or one of its locations.' })}
          >
            {({ id }) => (
              <Controller
                control={form.control}
                name="sourceWorkspaceId"
                render={({ field }) => (
                  <Select
                    value={field.value ? field.value : AGENCY_SOURCE}
                    onValueChange={(v) => field.onChange(v === AGENCY_SOURCE ? '' : v)}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AGENCY_SOURCE}>
                        {t('agency.snapshots.sourceAgency', { defaultValue: 'This agency workspace' })}
                      </SelectItem>
                      {locations.map((loc) => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {t('agency.snapshots.capture', { defaultValue: 'Capture' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
