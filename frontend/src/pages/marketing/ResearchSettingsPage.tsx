import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  BeakerIcon,
  KeyIcon,
  TrashIcon,
  ClipboardIcon,
  PauseCircleIcon,
  PlayCircleIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface ResearchProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  icpDescription: string;
  productPitch?: string | null;
  geo?: { country?: string; cities?: string[] } | null;
  language: string;
  exclusions?: string | null;
  lastRunAt?: string | null;
  lastRunStats?: {
    posted: number;
    created: number;
    skipped: number;
    clipped: number;
    at: string;
  } | null;
}

interface IngestTokenRow {
  id: string;
  tokenPrefix: string;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt?: string | null;
  createdAt: string;
}

const EMPTY_FORM = {
  name: '',
  icpDescription: '',
  productPitch: '',
  language: 'en',
  country: '',
  cities: '',
  exclusions: '',
};

/**
 * Research settings: the customer-authored briefs the nightly AI routine
 * researches against, the daily lead-quota meter, and ingest-token
 * management. Manager+ surface.
 */
export default function ResearchSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [tokenLabel, setTokenLabel] = useState('');
  const [mintedToken, setMintedToken] = useState<string | null>(null);

  const { data: usage } = useQuery({
    queryKey: ['marketing', 'research', 'usage'],
    queryFn: () => marketingApi.get('/research/usage').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const { data: profiles } = useQuery<ResearchProfile[]>({
    queryKey: ['marketing', 'research', 'profiles'],
    queryFn: () => marketingApi.get('/research/profiles').then((r) => r.data),
  });

  const { data: tokens } = useQuery<IngestTokenRow[]>({
    queryKey: ['marketing', 'research', 'tokens'],
    queryFn: () => marketingApi.get('/research/tokens').then((r) => r.data),
  });

  const invalidate = (key: string) =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'research', key] });

  const buildPayload = () => ({
    name: form.name,
    icpDescription: form.icpDescription,
    productPitch: form.productPitch || undefined,
    language: form.language,
    geo:
      form.country || form.cities
        ? {
            ...(form.country ? { country: form.country } : {}),
            ...(form.cities
              ? { cities: form.cities.split(',').map((c) => c.trim()).filter(Boolean) }
              : {}),
          }
        : undefined,
    exclusions: form.exclusions || undefined,
  });

  const saveProfile = useMutation({
    mutationFn: () =>
      editingId
        ? marketingApi.patch(`/research/profiles/${editingId}`, buildPayload())
        : marketingApi.post('/research/profiles', buildPayload()),
    onSuccess: () => {
      invalidate('profiles');
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      toast.success(t('research.saved', 'Research profile saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('research.saveFailed', 'Save failed')),
  });

  const toggleProfile = useMutation({
    mutationFn: (p: ResearchProfile) =>
      marketingApi.patch(`/research/profiles/${p.id}`, {
        status: p.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      }),
    onSuccess: () => invalidate('profiles'),
  });

  const deleteProfile = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/research/profiles/${id}`),
    onSuccess: () => invalidate('profiles'),
  });

  const mintToken = useMutation({
    mutationFn: () => marketingApi.post('/research/tokens', { label: tokenLabel }),
    onSuccess: ({ data }) => {
      setMintedToken(data.token);
      setTokenLabel('');
      invalidate('tokens');
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Mint failed'),
  });

  const revokeToken = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/research/tokens/${id}`),
    onSuccess: () => invalidate('tokens'),
  });

  const startEdit = (p: ResearchProfile) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      icpDescription: p.icpDescription,
      productPitch: p.productPitch ?? '',
      language: p.language,
      country: p.geo?.country ?? '',
      cities: (p.geo?.cities ?? []).join(', '),
      exclusions: p.exclusions ?? '',
    });
    setShowForm(true);
  };

  const quotaPct =
    usage && usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;

  const inputCls =
    'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {t('research.title', 'AI Research')}
          </h1>
          <p className="text-sm text-slate-500">
            {t(
              'research.subtitle',
              'Tell the nightly research agent who to find — it fills your pipeline up to your daily quota.',
            )}
          </p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setForm(EMPTY_FORM);
            setShowForm(true);
          }}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          {t('research.newProfile', 'New research profile')}
        </button>
      </div>

      {/* Quota meter */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-700">
            {t('research.quotaToday', "Today's lead quota")}
          </h2>
          <span className="text-sm text-slate-500">
            {usage
              ? usage.limit === -1
                ? `${usage.used} / ∞`
                : `${usage.used} / ${usage.limit}`
              : '…'}
          </span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              quotaPct >= 100 ? 'bg-amber-500' : 'bg-primary'
            }`}
            style={{ width: usage?.limit === -1 ? '8%' : `${quotaPct}%` }}
          />
        </div>
        <p className="text-xs text-slate-400 mt-2">
          {t(
            'research.quotaHint',
            'Resets at midnight UTC. Upgrade your package to raise the daily limit.',
          )}
        </p>
      </div>

      {/* Profile form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="font-semibold text-slate-900">
            {editingId
              ? t('research.editProfile', 'Edit profile')
              : t('research.newProfile', 'New research profile')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('research.name', 'Profile name')}</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="TR cafes — digital gaps" maxLength={120} />
            </div>
            <div>
              <label className={labelCls}>{t('research.language', 'Output language')}</label>
              <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} className={inputCls}>
                <option value="en">English</option>
                <option value="tr">Türkçe</option>
                <option value="ru">Русский</option>
                <option value="uz">Oʻzbekcha</option>
                <option value="ar">العربية</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>
              {t('research.icp', 'Who should the agent find? (ideal customer + pain signals)')}
            </label>
            <textarea
              value={form.icpDescription}
              onChange={(e) => setForm({ ...form, icpDescription: e.target.value })}
              className={`${inputCls} min-h-28`}
              maxLength={4000}
              placeholder={t(
                'research.icpPlaceholder',
                'e.g. Independent cafes and small restaurant groups (1-5 branches) showing slow-service complaints in recent reviews, active on Instagram but with no online ordering link…',
              )}
            />
            <p className="text-xs text-slate-400 mt-1">
              {form.icpDescription.length}/4000 ·{' '}
              {t('research.icpMin', 'min 40 characters — specific briefs get better leads')}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>{t('research.country', 'Country')}</label>
              <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className={inputCls} placeholder="TR" />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>{t('research.cities', 'Cities (comma separated)')}</label>
              <input value={form.cities} onChange={(e) => setForm({ ...form, cities: e.target.value })} className={inputCls} placeholder="Istanbul, Ankara, Izmir" />
            </div>
          </div>
          <div>
            <label className={labelCls}>{t('research.pitch', 'Pitch angle (optional)')}</label>
            <textarea value={form.productPitch} onChange={(e) => setForm({ ...form, productPitch: e.target.value })} className={`${inputCls} min-h-16`} maxLength={1000}
              placeholder={t('research.pitchPlaceholder', 'How should the opener position your product for these leads?')} />
          </div>
          <div>
            <label className={labelCls}>{t('research.exclusions', 'Hard exclusions (optional)')}</label>
            <input value={form.exclusions} onChange={(e) => setForm({ ...form, exclusions: e.target.value })} className={inputCls} maxLength={1000}
              placeholder={t('research.exclusionsPlaceholder', 'e.g. no franchises, skip hotel restaurants')} />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={() => saveProfile.mutate()}
              disabled={saveProfile.isPending || form.name.length === 0 || form.icpDescription.length < 40}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saveProfile.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}

      {/* Profiles */}
      <div className="space-y-3">
        {(profiles ?? []).map((p) => (
          <div key={p.id} className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <BeakerIcon className="w-5 h-5 text-primary" />
                <div>
                  <div className="font-medium text-slate-900 flex items-center gap-2">
                    {p.name}
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      p.status === 'ACTIVE'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-slate-100 text-slate-500 border-slate-200'
                    }`}>
                      {p.status === 'ACTIVE'
                        ? t('research.active', 'Active')
                        : t('research.paused', 'Paused')}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.icpDescription}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => toggleProfile.mutate(p)} title={p.status === 'ACTIVE' ? 'Pause' : 'Activate'}
                  className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">
                  {p.status === 'ACTIVE' ? <PauseCircleIcon className="w-5 h-5" /> : <PlayCircleIcon className="w-5 h-5" />}
                </button>
                <button onClick={() => startEdit(p)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                  {t('common.edit', 'Edit')}
                </button>
                <button onClick={() => deleteProfile.mutate(p.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
            {p.lastRunStats && (
              <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500 flex gap-4 flex-wrap">
                <span>{t('research.lastRun', 'Last run')}: {p.lastRunAt ? new Date(p.lastRunAt).toLocaleString() : '—'}</span>
                <span>{t('research.created', 'created')}: <strong className="text-emerald-600">{p.lastRunStats.created}</strong></span>
                <span>{t('research.skippedDupes', 'dupes')}: {p.lastRunStats.skipped}</span>
                <span>{t('research.clipped', 'over quota')}: {p.lastRunStats.clipped}</span>
              </div>
            )}
          </div>
        ))}
        {(profiles ?? []).length === 0 && !showForm && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">
            {t('research.empty', 'No research profiles yet — create one and the nightly agent starts hunting.')}
          </div>
        )}
      </div>

      {/* Ingest tokens */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <KeyIcon className="w-5 h-5 text-slate-400" />
            {t('research.tokens', 'Ingest tokens')}
          </h2>
        </div>
        <p className="text-xs text-slate-400">
          {t(
            'research.tokensHint',
            'For pushing leads from your own integrations (POST /api/marketing/leads/ingest with the x-ingest-token header). The platform research agent does not need one.',
          )}
        </p>

        {mintedToken && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-xs font-medium text-amber-800 mb-2">
              {t('research.tokenOnce', 'Copy this token now — it will never be shown again.')}
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-white border border-amber-200 rounded px-2 py-1.5 flex-1 break-all">{mintedToken}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(mintedToken); toast.success(t('common.copied', 'Copied')); }}
                className="p-2 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-100"
              >
                <ClipboardIcon className="w-4 h-4" />
              </button>
              <button onClick={() => setMintedToken(null)} className="text-xs text-amber-700 hover:underline">
                {t('common.done', 'Done')}
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <input value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} maxLength={120}
            placeholder={t('research.tokenLabel', 'Label (e.g. zapier-integration)')} className={inputCls} />
          <button
            onClick={() => mintToken.mutate()}
            disabled={!tokenLabel || mintToken.isPending}
            className="px-4 py-2 text-sm rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50 shrink-0"
          >
            {t('research.mint', 'Create token')}
          </button>
        </div>

        <div className="divide-y divide-slate-100">
          {(tokens ?? []).map((tok) => (
            <div key={tok.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
              <div>
                <code className="text-xs text-slate-600">{tok.tokenPrefix}…</code>
                <span className="ml-2 text-slate-700">{tok.label}</span>
                {tok.status === 'REVOKED' && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">revoked</span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span>
                  {tok.lastUsedAt
                    ? `${t('research.lastUsed', 'last used')} ${new Date(tok.lastUsedAt).toLocaleDateString()}`
                    : t('research.neverUsed', 'never used')}
                </span>
                {tok.status === 'ACTIVE' && (
                  <button onClick={() => revokeToken.mutate(tok.id)} className="text-red-400 hover:text-red-600">
                    {t('research.revoke', 'Revoke')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
