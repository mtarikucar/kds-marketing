import { lazy, Suspense, useRef, useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../components/RouteFallback';

// Lazy so a tab's code only loads when opened (each was its own route before).
const BrandKitPage = lazy(() => import('./BrandKitPage'));
const BrandBrainPage = lazy(() => import('./brandBrain/BrandBrainPage'));

const TABS = ['business', 'kit', 'brain'] as const;
type BrandTab = (typeof TABS)[number];

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Brand — the single unified brand surface. Business identity (customer-facing
 * branding), the visual Brand Kit and the Brand Brain knowledge base live here
 * as deep-linkable tabs (`?tab=`), so every view survives refresh/back and can
 * be shared.
 */
export default function BrandingSettingsPage() {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: BrandTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as BrandTab) : 'business';

  const setTab = (v: string) => setParams((p) => {
    p.set('tab', v);
    return p;
  }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('brand.title', 'Brand')}
        description={t('brand.subtitle', 'Your business identity, visual kit and AI brand voice — one place.')}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="business">{t('brand.tab.business', 'Business')}</TabsTrigger>
          <TabsTrigger value="kit">{t('brand.tab.kit', 'Brand Kit')}</TabsTrigger>
          <TabsTrigger value="brain">{t('brand.tab.brain', 'Brand Brain')}</TabsTrigger>
        </TabsList>

        <TabsContent value="business" className="pt-5">
          <BusinessTab />
        </TabsContent>
        <TabsContent value="kit" className="pt-5">
          <Lazy><BrandKitPage embedded /></Lazy>
        </TabsContent>
        <TabsContent value="brain" className="pt-5">
          <Lazy><BrandBrainPage embedded /></Lazy>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Business tab (the original Branding settings body) ──────────────────────

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

function BusinessTab() {
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
                  // Match the backend's accepted types (png/jpeg/webp). SVG was
                  // advertised here but the server rejects it (it can carry
                  // embedded scripts), so picking an SVG just failed the upload.
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload.mutate(f);
                    // Reset so re-selecting the SAME file fires onChange again
                    // (browsers suppress change for an identical selection).
                    e.target.value = '';
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
                {t('branding.logoHint', 'PNG, JPEG or WEBP, under 1 MB.')}
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
