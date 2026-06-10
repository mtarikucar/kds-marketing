import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { SwatchIcon, PhotoIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { API_URL } from '../../lib/env';

interface Branding { brandName: string | null; accentColor: string | null; logoUrl: string | null }

export default function BrandingSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [brandName, setBrandName] = useState('');
  const [accentColor, setAccentColor] = useState('#1e40af');

  const { data } = useQuery<Branding>({ queryKey: ['marketing', 'branding'], queryFn: () => marketingApi.get('/branding').then((r) => r.data) });
  useEffect(() => {
    if (data) { setBrandName(data.brandName ?? ''); setAccentColor(data.accentColor ?? '#1e40af'); }
  }, [data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'branding'] });
  const save = useMutation({
    mutationFn: () => marketingApi.put('/branding', { brandName: brandName || null, accentColor }),
    onSuccess: () => { invalidate(); toast.success(t('branding.saved', 'Branding saved')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('branding.saveFailed', 'Save failed')),
  });
  const upload = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append('file', file); return marketingApi.post('/branding/logo', fd); },
    onSuccess: () => { invalidate(); toast.success(t('branding.logoUploaded', 'Logo uploaded')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('branding.logoFailed', 'Upload failed')),
  });

  // logoUrl is a relative /api/public/uploads path; API_URL ends in /api.
  const logoSrc = data?.logoUrl ? `${API_URL.replace(/\/api$/, '')}${data.logoUrl}` : null;
  const inputCls = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('branding.title', 'Branding')}</h1>
        <p className="text-sm text-slate-500">{t('branding.subtitle', 'Your brand on the customer-facing surfaces — funnel pages and the web-chat widget.')}</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div>
          <label className={labelCls}>{t('branding.brandName', 'Brand name')}</label>
          <input value={brandName} onChange={(e) => setBrandName(e.target.value)} className={`${inputCls} w-full`} maxLength={120} placeholder="Acme Co." />
        </div>
        <div>
          <label className={labelCls}><SwatchIcon className="w-4 h-4 inline" /> {t('branding.accent', 'Accent color')}</label>
          <div className="flex items-center gap-2">
            <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="w-12 h-9 rounded border border-slate-300" />
            <input value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className={inputCls} maxLength={7} />
          </div>
        </div>
        <div>
          <label className={labelCls}><PhotoIcon className="w-4 h-4 inline" /> {t('branding.logo', 'Logo')}</label>
          <div className="flex items-center gap-3">
            {logoSrc && <img src={logoSrc} alt="logo" className="h-10 border border-slate-200 rounded p-1" />}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }} />
            <button onClick={() => fileRef.current?.click()} disabled={upload.isPending} className="px-3 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
              {upload.isPending ? t('branding.uploading', 'Uploading…') : t('branding.uploadLogo', 'Upload logo')}
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-1">{t('branding.logoHint', 'PNG, JPEG, WEBP or SVG, under 1 MB.')}</p>
        </div>
        <div className="flex justify-end">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50">
            {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </div>

      {/* Preview */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 text-white font-medium flex items-center gap-2" style={{ background: accentColor }}>
          {logoSrc && <img src={logoSrc} alt="" className="h-6" />}{brandName || t('branding.previewName', 'Your brand')}
        </div>
        <div className="p-4 text-sm text-slate-500">{t('branding.preview', 'This is how your brand appears on public pages and the chat widget.')}</div>
      </div>
    </div>
  );
}
