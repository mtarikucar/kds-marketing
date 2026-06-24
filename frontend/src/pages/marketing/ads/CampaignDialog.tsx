import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import {
  createCampaignSchema,
  type CreateCampaignFormValues,
  CAMPAIGN_OBJECTIVES,
  OBJECTIVE_LABEL,
} from './adManagementSchemas';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

interface CampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CreateCampaignFormValues) => void;
  isPending: boolean;
}

export function CampaignDialog({ open, onOpenChange, onSubmit, isPending }: CampaignDialogProps) {
  const { t } = useTranslation('marketing');

  const form = useForm<CreateCampaignFormValues>({
    resolver: zodResolver(createCampaignSchema),
    mode: 'onBlur',
    defaultValues: { name: '', objective: 'OUTCOME_LEADS' },
  });

  useEffect(() => {
    if (open) form.reset({ name: '', objective: 'OUTCOME_LEADS' });
  }, [open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<CreateCampaignFormValues> = (values) => onSubmit(values);

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('ads.campaign.newTitle', { defaultValue: 'New campaign' })}</DialogTitle>
          <DialogDescription>
            {t('ads.campaign.newSubtitle', {
              defaultValue: 'Create a paused campaign with the chosen objective. Add ad sets and ads in Meta Ads Manager.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('ads.campaign.name', { defaultValue: 'Campaign name' })}
            error={fieldErr(errors.name?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('ads.campaign.namePlaceholder', { defaultValue: 'e.g. Spring promo — Leads' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field
            label={t('ads.campaign.objective', { defaultValue: 'Objective' })}
            error={fieldErr(errors.objective?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="objective"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAMPAIGN_OBJECTIVES.map((o) => (
                        <SelectItem key={o} value={o}>
                          {t(`ads.objective.${o}`, { defaultValue: OBJECTIVE_LABEL[o] })}
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
              {t('ads.campaign.create', { defaultValue: 'Create campaign' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
