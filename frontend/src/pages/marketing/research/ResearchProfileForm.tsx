import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

// ── Schema + types ────────────────────────────────────────────────────────────

export const researchProfileSchema = z.object({
  name: z.string().min(1, 'Required').max(120),
  icpDescription: z.string().min(40, 'At least 40 characters').max(4000),
  productPitch: z.string().max(1000).optional(),
  language: z.string().min(1),
  country: z.string().max(10).optional(),
  regions: z.string().max(500).optional(),
  cities: z.string().max(500).optional(),
  businessTypes: z.string().max(500).optional(),
  exclusions: z.string().max(1000).optional(),
});

export type ResearchProfileFormValues = z.infer<typeof researchProfileSchema>;

export const RESEARCH_PROFILE_DEFAULTS: ResearchProfileFormValues = {
  name: '',
  icpDescription: '',
  productPitch: '',
  language: 'en',
  country: '',
  regions: '',
  cities: '',
  businessTypes: '',
  exclusions: '',
};

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'ru', label: 'Русский' },
  { value: 'uz', label: 'Oʻzbekcha' },
  { value: 'ar', label: 'العربية' },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface ResearchProfileFormProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isEditing: boolean;
  defaultValues: ResearchProfileFormValues;
  isPending: boolean;
  onSubmit: (values: ResearchProfileFormValues) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ResearchProfileForm({
  open,
  onOpenChange,
  isEditing,
  defaultValues,
  isPending,
  onSubmit,
}: ResearchProfileFormProps) {
  const { t } = useTranslation('marketing');

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<ResearchProfileFormValues>({
    resolver: zodResolver(researchProfileSchema),
    values: defaultValues,
  });

  const icpValue = watch('icpDescription');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('research.editProfile', 'Edit profile')
              : t('research.newProfile', 'New research profile')}
          </DialogTitle>
          <DialogDescription>
            {t('research.formDesc', 'Tell the research agent who to find.')}
          </DialogDescription>
        </DialogHeader>

        <form
          id="research-profile-form"
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={t('research.name', 'Profile name')}
              error={errors.name?.message}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="TR cafes — digital gaps"
                  maxLength={120}
                  {...register('name')}
                />
              )}
            </Field>

            <Field
              label={t('research.language', 'Output language')}
              error={errors.language?.message}
              required
            >
              {({ id }) => (
                <Controller
                  name="language"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGES.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
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
            label={t('research.icp', 'Who should the agent find? (ideal customer + pain signals)')}
            error={errors.icpDescription?.message}
            hint={`${icpValue?.length ?? 0}/4000 · ${t(
              'research.icpMin',
              'min 40 characters — specific briefs get better leads',
            )}`}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="min-h-28"
                maxLength={4000}
                placeholder={t(
                  'research.icpPlaceholder',
                  'e.g. Independent cafes and small restaurant groups (1-5 branches) showing slow-service complaints in recent reviews, active on Instagram but with no online ordering link…',
                )}
                {...register('icpDescription')}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label={t('research.country', 'Country')} error={errors.country?.message}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="TR" {...register('country')} />
              )}
            </Field>

            <Field label={t('research.regions', 'Regions (comma separated)')} error={errors.regions?.message}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="Marmara, Ege" {...register('regions')} />
              )}
            </Field>

            <Field label={t('research.cities', 'Cities (comma separated)')} error={errors.cities?.message}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="Istanbul, Ankara, Izmir" {...register('cities')} />
              )}
            </Field>
          </div>

          <Field
            label={t('research.businessTypes', 'Business types (comma separated, optional)')}
            error={errors.businessTypes?.message}
            hint={t('research.businessTypesHint', 'Hard filter — e.g. CAFE, RESTAURANT, SALON. Leave blank to let the ICP text decide.')}
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="CAFE, RESTAURANT, BAKERY" {...register('businessTypes')} />
            )}
          </Field>

          <Field
            label={t('research.pitch', 'Pitch angle (optional)')}
            error={errors.productPitch?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="min-h-16"
                maxLength={1000}
                placeholder={t(
                  'research.pitchPlaceholder',
                  'How should the opener position your product for these leads?',
                )}
                {...register('productPitch')}
              />
            )}
          </Field>

          <Field
            label={t('research.exclusions', 'Hard exclusions (optional)')}
            error={errors.exclusions?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                maxLength={1000}
                placeholder={t(
                  'research.exclusionsPlaceholder',
                  'e.g. no franchises, skip hotel restaurants',
                )}
                {...register('exclusions')}
              />
            )}
          </Field>
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="submit" form="research-profile-form" loading={isPending}>
            {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
