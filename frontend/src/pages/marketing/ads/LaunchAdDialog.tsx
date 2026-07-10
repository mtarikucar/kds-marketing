import { useEffect } from 'react';
import { useForm, Controller, type Resolver, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import {
  launchAdSchema,
  type LaunchAdFormValues,
  type LaunchAdFormOutput,
  CAMPAIGN_OBJECTIVES,
  OBJECTIVE_LABEL,
  CALL_TO_ACTIONS,
  CTA_LABEL,
} from './adManagementSchemas';
import type { LaunchAdPayload } from '../../../features/marketing/api/ads.service';
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
import { Textarea } from '@/components/ui/Textarea';
import { Callout } from '@/components/ui/Callout';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

interface LaunchAdDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: LaunchAdPayload) => void;
  isPending: boolean;
}

const DEFAULTS: LaunchAdFormValues = {
  generatedAssetId: '',
  adsetName: '',
  dailyBudget: '',
  objective: 'OUTCOME_TRAFFIC',
  link: '',
  primaryText: '',
  callToAction: 'LEARN_MORE',
  country: '',
};

/**
 * Build the full LaunchAdDto payload from the lean form: targeting is derived
 * from the country, and optimizationGoal/billingEvent take traffic-friendly
 * defaults. The ad launches PAUSED so it never immediately spends.
 */
export function buildLaunchPayload(v: LaunchAdFormOutput): LaunchAdPayload {
  return {
    generatedAssetId: v.generatedAssetId,
    adsetName: v.adsetName,
    campaignName: v.adsetName,
    objective: v.objective,
    dailyBudget: v.dailyBudget,
    optimizationGoal: 'LINK_CLICKS',
    billingEvent: 'IMPRESSIONS',
    targeting: { geo_locations: { countries: [v.country] } },
    link: v.link,
    primaryText: v.primaryText,
    callToAction: v.callToAction,
    status: 'PAUSED',
  };
}

export function LaunchAdDialog({ open, onOpenChange, onSubmit, isPending }: LaunchAdDialogProps) {
  const { t } = useTranslation('marketing');

  const form = useForm<LaunchAdFormValues, unknown, LaunchAdFormOutput>({
    // Input/output types differ (budget/country transform); cast keeps RHF happy.
    resolver: zodResolver(launchAdSchema) as Resolver<LaunchAdFormValues, unknown, LaunchAdFormOutput>,
    mode: 'onBlur',
    defaultValues: DEFAULTS,
  });

  useEffect(() => {
    if (open) form.reset(DEFAULTS);
  }, [open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<LaunchAdFormOutput> = (values) =>
    onSubmit(buildLaunchPayload(values));

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('ads.launch.title', { defaultValue: 'Launch ad from creative' })}</DialogTitle>
          <DialogDescription>
            {t('ads.launch.subtitle', {
              defaultValue:
                'Turn a generated creative into a paused Meta ad (campaign → ad set → creative → ad). It launches PAUSED so it never immediately spends.',
            })}
          </DialogDescription>
        </DialogHeader>

        <Callout tone="info">
          {t('ads.launch.pausedNote', {
            defaultValue: 'The ad is created PAUSED — review and resume it in the campaigns table to go live.',
          })}
        </Callout>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('ads.launch.assetId', { defaultValue: 'Generated asset ID' })}
            hint={t('ads.launch.assetIdHint', { defaultValue: 'The id of a READY image/video from the Content Studio.' })}
            error={fieldErr(errors.generatedAssetId?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="asset_…"
                {...form.register('generatedAssetId')}
              />
            )}
          </Field>

          <Field
            label={t('ads.launch.adsetName', { defaultValue: 'Ad set name' })}
            error={fieldErr(errors.adsetName?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('ads.launch.adsetNamePlaceholder', { defaultValue: 'e.g. Spring promo — US traffic' })}
                {...form.register('adsetName')}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('ads.launch.dailyBudget', { defaultValue: 'Daily budget' })}
              hint={t('ads.launch.dailyBudgetHint', { defaultValue: 'Major units (e.g. 25).' })}
              error={fieldErr(errors.dailyBudget?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  min={0}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="25"
                  {...form.register('dailyBudget')}
                />
              )}
            </Field>

            <Field
              label={t('ads.launch.country', { defaultValue: 'Targeting country' })}
              hint={t('ads.launch.countryHint', { defaultValue: '2-letter code (e.g. US, TR).' })}
              error={fieldErr(errors.country?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  maxLength={2}
                  placeholder="US"
                  className="uppercase"
                  {...form.register('country')}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('ads.launch.objective', { defaultValue: 'Objective' })}
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

            <Field
              label={t('ads.launch.cta', { defaultValue: 'Call to action' })}
              error={fieldErr(errors.callToAction?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="callToAction"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CALL_TO_ACTIONS.map((c) => (
                          <SelectItem key={c} value={c}>
                            {t(`ads.cta.${c}`, { defaultValue: CTA_LABEL[c] })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('ads.launch.link', { defaultValue: 'Destination link' })}
            error={fieldErr(errors.link?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="url"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="https://example.com/landing"
                {...form.register('link')}
              />
            )}
          </Field>

          <Field
            label={t('ads.launch.primaryText', { defaultValue: 'Primary text' })}
            error={fieldErr(errors.primaryText?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('ads.launch.primaryTextPlaceholder', { defaultValue: 'The ad copy shown above the creative.' })}
                {...form.register('primaryText')}
              />
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {t('ads.launch.submit', { defaultValue: 'Launch (paused)' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
