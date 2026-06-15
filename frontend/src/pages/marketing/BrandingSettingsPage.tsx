import { useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Palette, Upload } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { API_URL } from '../../lib/env';
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Input,
  Button,
} from '@/components/ui';

// ── Schema ───────────────────────────────────────────────────────────────────

const brandingSchema = z.object({
  brandName: z.string().max(120).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color (e.g. #1e40af)'),
});

type BrandingForm = z.infer<typeof brandingSchema>;

interface Branding {
  brandName: string | null;
  accentColor: string | null;
  logoUrl: string | null;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function BrandingSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const { data } = useQuery<Branding>({
    queryKey: ['marketing', 'branding'],
    queryFn: () => marketingApi.get('/branding').then((r) => r.data),
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<BrandingForm>({
    resolver: zodResolver(brandingSchema),
    defaultValues: { brandName: '', accentColor: '#1e40af' },
  });

  // Populate form when remote data arrives.
  useEffect(() => {
    if (data) {
      reset({
        brandName: data.brandName ?? '',
        accentColor: data.accentColor ?? '#1e40af',
      });
    }
  }, [data, reset]);

  const accentColor = watch('accentColor');
  const brandName = watch('brandName');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'branding'] });

  const save = useMutation({
    mutationFn: (values: BrandingForm) =>
      marketingApi.put('/branding', {
        brandName: values.brandName || null,
        accentColor: values.accentColor,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('branding.saved', 'Branding saved'));
    },
    onError: (e: any) =>
      toast.error(
        e.response?.data?.message ?? t('branding.saveFailed', 'Save failed'),
      ),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return marketingApi.post('/branding/logo', fd);
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('branding.logoUploaded', 'Logo uploaded'));
    },
    onError: (e: any) =>
      toast.error(
        e.response?.data?.message ?? t('branding.logoFailed', 'Upload failed'),
      ),
  });

  // logoUrl is a relative /api/public/uploads path; API_URL ends in /api.
  const logoSrc = data?.logoUrl
    ? `${API_URL.replace(/\/api$/, '')}${data.logoUrl}`
    : null;

  const onSubmit = (values: BrandingForm) => save.mutate(values);

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader
        title={t('branding.title', 'Branding')}
        description={t(
          'branding.subtitle',
          'Your brand on the customer-facing surfaces — funnel pages and the web-chat widget.',
        )}
      />

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <Card>
          <CardHeader>
            <CardTitle>{t('branding.settings', 'Brand settings')}</CardTitle>
            <CardDescription>
              {t(
                'branding.settingsDesc',
                'Customise how your brand appears to customers.',
              )}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            {/* Brand name */}
            <Field
              label={t('branding.brandName', 'Brand name')}
              error={errors.brandName?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="Acme Co."
                  maxLength={120}
                  {...register('brandName')}
                />
              )}
            </Field>

            {/* Accent color */}
            <Field
              label={t('branding.accent', 'Accent color')}
              error={errors.accentColor?.message}
            >
              {({ id, describedBy, invalid }) => (
                <div className="flex items-center gap-2">
                  {/* Color picker — syncs value into RHF via setValue */}
                  <input
                    type="color"
                    aria-label={t('branding.accentPicker', 'Color picker')}
                    value={accentColor ?? '#1e40af'}
                    onChange={(e) =>
                      setValue('accentColor', e.target.value, {
                        shouldValidate: true,
                        shouldDirty: true,
                      })
                    }
                    className="w-12 h-9 rounded-lg border border-border-strong bg-surface cursor-pointer p-0.5"
                  />
                  {/* Text input — registered with RHF so hex edits also update the picker */}
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    maxLength={7}
                    placeholder="#1e40af"
                    {...register('accentColor')}
                  />
                  <Palette className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                </div>
              )}
            </Field>

            {/* Logo upload */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">
                <Upload className="w-4 h-4 inline mr-1" aria-hidden />
                {t('branding.logo', 'Logo')}
              </p>
              <div className="flex items-center gap-3">
                {logoSrc && (
                  <img
                    src={logoSrc}
                    alt="logo"
                    className="h-10 border border-border rounded-lg p-1 bg-surface"
                  />
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload.mutate(f);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={upload.isPending}
                  loading={upload.isPending}
                >
                  {upload.isPending
                    ? t('branding.uploading', 'Uploading…')
                    : t('branding.uploadLogo', 'Upload logo')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('branding.logoHint', 'PNG, JPEG, WEBP or SVG, under 1 MB.')}
              </p>
            </div>
          </CardContent>

          <CardFooter className="justify-end border-t border-border pt-4">
            <Button
              type="submit"
              disabled={save.isPending || !isDirty}
              loading={save.isPending}
            >
              {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </Button>
          </CardFooter>
        </Card>
      </form>

      {/* Live preview */}
      <Card className="overflow-hidden">
        <div
          className="px-4 py-3 text-white font-medium flex items-center gap-2"
          style={{ background: accentColor ?? '#1e40af' }}
        >
          {logoSrc && <img src={logoSrc} alt="" className="h-6" />}
          {brandName || t('branding.previewName', 'Your brand')}
        </div>
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground">
            {t(
              'branding.preview',
              'This is how your brand appears on public pages and the chat widget.',
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
