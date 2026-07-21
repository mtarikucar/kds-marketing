import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Input,
  Textarea,
  Button,
  Switch,
} from '@/components/ui';
import {
  getBrandProfile,
  putBrandProfile,
  type BrandProfilePayload,
} from '../../../features/marketing/api/brandBrain.service';

// One list item per line in the textarea — the robust, testable representation
// (no dependency on a chip/tag input).
const linesToArray = (v: string) =>
  v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const arrayToLines = (v?: string[] | null) => (v ?? []).join('\n');

const brandProfileSchema = z.object({
  brandName: z.string().min(1, 'Required'),
  tagline: z.string().optional(),
  description: z.string().optional(),
  valueProps: z.string().optional(),
  toneWords: z.string().optional(),
  voiceGuide: z.string().optional(),
  icpDescription: z.string().optional(),
  audienceObjections: z.string().optional(),
  active: z.boolean(),
});

type BrandProfileForm = z.infer<typeof brandProfileSchema>;

const EMPTY_DEFAULTS: BrandProfileForm = {
  brandName: '',
  tagline: '',
  description: '',
  valueProps: '',
  toneWords: '',
  voiceGuide: '',
  icpDescription: '',
  audienceObjections: '',
  active: false,
};

/**
 * Manual editor for the consolidated Brand Profile — the fields here are
 * exactly what BrandContextService.render() reads to build the always-on AI
 * grounding block (plus tagline + status). A profile only grounds the AI once
 * its status is ACTIVE; DRAFT is saved but inert. `offerings` and
 * `socialHandles` are intentionally out of scope for this manual editor (they
 * don't feed the grounding block and are better captured by the Phase-3
 * auto-extraction wizard) — this form never sends them, and the backend
 * upsert is partial-safe so they're left untouched server-side.
 */
export default function BrandProfileEditor() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['marketing', 'brand-brain', 'profile'],
    queryFn: getBrandProfile,
  });

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isDirty },
  } = useForm<BrandProfileForm>({
    resolver: zodResolver(brandProfileSchema),
    defaultValues: EMPTY_DEFAULTS,
  });

  // Populate the form when remote data arrives (or leave the empty defaults
  // for a fresh workspace whose profile is null).
  useEffect(() => {
    if (data) {
      reset({
        brandName: data.brandName ?? '',
        tagline: data.tagline ?? '',
        description: data.description ?? '',
        valueProps: arrayToLines(data.valueProps),
        toneWords: arrayToLines(data.toneWords),
        voiceGuide: data.voiceGuide ?? '',
        icpDescription: data.icpDescription ?? '',
        audienceObjections: arrayToLines(data.audienceObjections),
        active: data.status === 'ACTIVE',
      });
    }
  }, [data, reset]);

  const save = useMutation({
    mutationFn: (values: BrandProfileForm) => {
      const payload: BrandProfilePayload = {
        brandName: values.brandName,
        tagline: values.tagline || null,
        description: values.description || null,
        valueProps: linesToArray(values.valueProps ?? ''),
        toneWords: linesToArray(values.toneWords ?? ''),
        voiceGuide: values.voiceGuide || null,
        icpDescription: values.icpDescription || null,
        audienceObjections: linesToArray(values.audienceObjections ?? ''),
        status: values.active ? 'ACTIVE' : 'DRAFT',
      };
      return putBrandProfile(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'brand-brain', 'profile'] });
      toast.success(t('brand.brain.editor.saved', 'Brand profile saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('brand.brain.editor.saveFailed', 'Save failed')),
  });

  const onSubmit = (values: BrandProfileForm) => save.mutate(values);

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>{t('brand.brain.editor.title', 'Brand profile')}</CardTitle>
          <CardDescription>
            {t(
              'brand.brain.editor.subtitle',
              'The one consolidated profile that grounds every AI — conversations, content, social and voice.',
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <Field label={t('brand.brain.editor.brandName', 'Brand name')} error={errors.brandName?.message} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Acme Co."
                {...register('brandName')}
              />
            )}
          </Field>

          <Field label={t('brand.brain.editor.tagline', 'Tagline')} error={errors.tagline?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...register('tagline')} />
            )}
          </Field>

          <Field label={t('brand.brain.editor.description', 'Description')} error={errors.description?.message}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...register('description')} />
            )}
          </Field>

          <Field
            label={t('brand.brain.editor.valueProps', 'Value propositions')}
            hint={t('brand.brain.editor.oneItemPerLine', 'One item per line.')}
            error={errors.valueProps?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...register('valueProps')} />
            )}
          </Field>

          <Field
            label={t('brand.brain.editor.toneWords', 'Tone words')}
            hint={t('brand.brain.editor.oneItemPerLine', 'One item per line.')}
            error={errors.toneWords?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...register('toneWords')} />
            )}
          </Field>

          <Field label={t('brand.brain.editor.voiceGuide', 'Voice guide')} error={errors.voiceGuide?.message}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...register('voiceGuide')} />
            )}
          </Field>

          <Field label={t('brand.brain.editor.icpDescription', 'Ideal customer')} error={errors.icpDescription?.message}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} {...register('icpDescription')} />
            )}
          </Field>

          <Field
            label={t('brand.brain.editor.audienceObjections', 'Audience objections')}
            hint={t('brand.brain.editor.oneItemPerLine', 'One item per line.')}
            error={errors.audienceObjections?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                rows={3}
                {...register('audienceObjections')}
              />
            )}
          </Field>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t('brand.brain.editor.activate', 'Grounding active')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  'brand.brain.editor.activateHint',
                  'Only an active profile grounds the AI — a draft is saved but has no effect yet.',
                )}
              </p>
            </div>
            <Controller
              name="active"
              control={control}
              render={({ field }) => (
                <Switch
                  aria-label={t('brand.brain.editor.activate', 'Grounding active')}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
          </div>
        </CardContent>

        <CardFooter className="justify-end border-t border-border pt-4">
          <Button type="submit" disabled={save.isPending || !isDirty} loading={save.isPending}>
            {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
