import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Upload, Trash2 } from 'lucide-react';
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
  Textarea,
  Button,
  IconButton,
} from '@/components/ui';
import marketingApi from '../../features/marketing/api/marketingApi';
import {
  getBrandKit,
  updateBrandKit,
  uploadReferenceImage,
  type BrandKit,
} from '../../features/marketing/api/brandKit.service';

export default function BrandKitPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const logoRef = useRef<HTMLInputElement>(null);
  const refRef = useRef<HTMLInputElement>(null);
  const hydrated = useRef(false);

  const [tone, setTone] = useState('');
  const [palette, setPalette] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [cta, setCta] = useState('');

  const { data } = useQuery<BrandKit>({
    queryKey: ['marketing', 'brandKit'],
    queryFn: getBrandKit,
  });

  // Seed the text fields from the server only once, on first hydration. Later
  // refetches (e.g. logo/reference uploads invalidate the query) must not clobber
  // the user's unsaved edits to tone/palette/hashtags/cta.
  useEffect(() => {
    if (!data || hydrated.current) return;
    hydrated.current = true;
    setTone(data.tone ?? '');
    setPalette((data.palette ?? []).join(', '));
    setHashtags((data.defaultHashtags ?? []).join(' '));
    setCta(data.defaultCta ?? '');
  }, [data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'brandKit'] });

  const save = useMutation({
    mutationFn: () =>
      updateBrandKit({
        tone: tone.trim() || null,
        palette: palette.split(',').map((s) => s.trim()).filter(Boolean),
        defaultHashtags: hashtags.split(/\s+/).map((s) => s.trim()).filter(Boolean),
        defaultCta: cta.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.saved', 'Brand kit saved'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('brandKit.saveFailed', 'Save failed')),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      const { data: m } = await marketingApi.post('/social-planner/media', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return updateBrandKit({ logoUrl: m.url, logoR2Key: m.key });
    },
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.logoUploaded', 'Logo uploaded'));
    },
    onError: () => toast.error(t('brandKit.logoFailed', 'Upload failed')),
  });

  const uploadRef = useMutation({
    mutationFn: (file: File) => uploadReferenceImage(file),
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.refUploaded', 'Reference image added'));
    },
    onError: () => toast.error(t('brandKit.refFailed', 'Upload failed')),
  });

  const removeRef = useMutation({
    // referenceImages is managed by the backend; PUT the filtered list to drop one.
    mutationFn: (r2Key: string) =>
      marketingApi.put('/brand-kit', {
        referenceImages: (data?.referenceImages ?? []).filter((i) => i.r2Key !== r2Key),
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('brandKit.refRemoved', 'Reference image removed'));
    },
    onError: () => toast.error(t('brandKit.refFailed', 'Upload failed')),
  });

  return (
    <div className="max-w-2xl space-y-6">
      {!embedded && (
      <PageHeader
        title={t('brandKit.title', 'Brand Kit')}
        description={t('brandKit.subtitle', 'Logo, palette, tone and references reused across AI generations.')}
      />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('brandKit.identity', 'Brand identity')}</CardTitle>
          <CardDescription>{t('brandKit.identityDesc', 'Used to keep generated content on-brand.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Logo */}
          <div className="space-y-2">
            <span className="text-sm font-medium text-foreground">{t('brandKit.logo', 'Logo')}</span>
            <div className="flex items-center gap-3">
              {data?.logoUrl && <img src={data.logoUrl} alt="logo" className="h-12 w-12 rounded object-contain" />}
              <input
                ref={logoRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && uploadLogo.mutate(e.target.files[0])}
              />
              <Button type="button" variant="outline" size="sm" loading={uploadLogo.isPending} onClick={() => logoRef.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t('brandKit.uploadLogo', 'Upload logo')}
              </Button>
            </div>
          </div>

          <Field label={t('brandKit.palette', 'Palette (comma-separated hex)')}>
            {({ id }) => <Input id={id} placeholder="#1e40af, #f59e0b" value={palette} onChange={(e) => setPalette(e.target.value)} />}
          </Field>

          <Field label={t('brandKit.tone', 'Brand tone / voice')}>
            {({ id }) => <Textarea id={id} rows={3} value={tone} onChange={(e) => setTone(e.target.value)} />}
          </Field>

          <Field label={t('brandKit.hashtags', 'Default hashtags')}>
            {({ id }) => <Input id={id} placeholder="#jeeta #marketing" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />}
          </Field>

          <Field label={t('brandKit.cta', 'Default call-to-action')}>
            {({ id }) => <Input id={id} value={cta} onChange={(e) => setCta(e.target.value)} />}
          </Field>

          {/* Reference images */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">{t('brandKit.references', 'Reference images')}</span>
              <input
                ref={refRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && uploadRef.mutate(e.target.files[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={uploadRef.isPending}
                disabled={(data?.referenceImages?.length ?? 0) >= 5}
                onClick={() => refRef.current?.click()}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t('brandKit.addReference', 'Add reference')}
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {(data?.referenceImages ?? []).map((img) => (
                <div key={img.r2Key} className="relative">
                  <img src={img.url} alt="reference" className="aspect-square w-full rounded object-cover" />
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label={t('brandKit.removeReference', 'Remove')}
                    className="absolute end-1 top-1 bg-surface/80"
                    onClick={() => removeRef.mutate(img.r2Key)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {t('brandKit.save', 'Save')}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
