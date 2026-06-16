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
import { communitySchema, type CommunityFormValues } from '../schemas';
import type { Community } from '../types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  community?: Community | null;
  onSubmit: (values: CommunityFormValues) => void;
  isPending: boolean;
}

export function CommunityFormDialog({ open, onOpenChange, community, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!community;

  const form = useForm<CommunityFormValues>({
    resolver: zodResolver(communitySchema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (!open) return;
    if (community) {
      form.reset({ name: community.name, description: community.description ?? '' });
    } else {
      form.reset({ name: '', description: '' });
    }
  }, [community, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`memberships.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<CommunityFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('memberships.communities.editTitle', { defaultValue: 'Edit community' })
              : t('memberships.communities.createTitle', { defaultValue: 'New community' })}
          </DialogTitle>
          <DialogDescription>
            {t('memberships.communities.dialogDesc', {
              defaultValue: 'A community is a space for members to post and discuss.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('memberships.communities.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />
            )}
          </Field>

          <Field label={t('memberships.communities.description', { defaultValue: 'Description' })} error={fieldErr(errors.description?.message)}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...form.register('description')} />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('memberships.communities.createTitle', { defaultValue: 'New community' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
