import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ChatBubbleLeftRightIcon,
  TrashIcon,
  ClipboardIcon,
  CheckBadgeIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  status: string;
  agentProfileId?: string | null;
  widgetKey?: string | null;
  externalId?: string | null;
  configuredSecrets: string[];
  lastVerifiedAt?: string | null;
}
interface AgentRow {
  id: string;
  name: string;
}

const CHANNEL_TYPES = ['WEBCHAT', 'WHATSAPP', 'SMS', 'INSTAGRAM', 'MESSENGER'] as const;

// Secret + external-id fields the operator must supply, per channel type.
const SECRET_FIELDS: Record<string, string[]> = {
  WEBCHAT: [],
  WHATSAPP: ['accessToken', 'phoneNumberId'],
  SMS: ['usercode', 'password', 'msgheader'],
  INSTAGRAM: ['pageAccessToken'],
  MESSENGER: ['pageAccessToken'],
};
const NEEDS_EXTERNAL_ID: Record<string, string> = {
  WHATSAPP: 'Phone number ID',
  INSTAGRAM: 'Page ID',
  MESSENGER: 'Page ID',
};

export default function ChannelsSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<string>('WEBCHAT');
  const [name, setName] = useState('');
  const [agentProfileId, setAgentProfileId] = useState('');
  const [externalId, setExternalId] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const { data: channels } = useQuery<ChannelRow[]>({
    queryKey: ['marketing', 'channels'],
    queryFn: () => marketingApi.get('/channels').then((r) => r.data),
  });
  const { data: agents } = useQuery<AgentRow[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'channels'] });

  const reset = () => {
    setShowForm(false);
    setType('WEBCHAT');
    setName('');
    setAgentProfileId('');
    setExternalId('');
    setSecrets({});
  };

  const create = useMutation({
    mutationFn: () =>
      marketingApi.post('/channels', {
        type,
        name,
        agentProfileId: agentProfileId || undefined,
        externalId: externalId || undefined,
        secrets: Object.keys(secrets).length ? secrets : undefined,
      }),
    onSuccess: () => {
      invalidate();
      reset();
      toast.success(t('channels.saved', 'Channel saved'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('channels.saveFailed', 'Save failed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/channels/${id}`),
    onSuccess: invalidate,
  });
  const verify = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/channels/${id}/verify`),
    onSuccess: ({ data }) => {
      invalidate();
      toast[data?.ok ? 'success' : 'error'](
        data?.ok ? t('channels.verifyOk', 'Channel verified ✓') : t('channels.verifyFail', 'Verification failed — check credentials'),
      );
    },
  });

  const embedSnippet = (widgetKey: string) =>
    `<script src="${window.location.origin}/widget.js" data-widget-key="${widgetKey}" async></script>`;

  const inputCls =
    'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('channels.title', 'Channels')}</h1>
          <p className="text-sm text-slate-500">
            {t('channels.subtitle', 'Connect where your customers message you — web chat, WhatsApp, SMS, Instagram, Messenger. Pick which AI agent answers on each.')}
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          {t('channels.new', 'Connect a channel')}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>{t('channels.type', 'Type')}</label>
              <select value={type} onChange={(e) => { setType(e.target.value); setSecrets({}); setExternalId(''); }} className={inputCls}>
                {CHANNEL_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{ty}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('channels.name', 'Name')}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Support line" maxLength={120} />
            </div>
            <div>
              <label className={labelCls}>{t('channels.agent', 'Answering agent')}</label>
              <select value={agentProfileId} onChange={(e) => setAgentProfileId(e.target.value)} className={inputCls}>
                <option value="">{t('channels.noAgent', '— none (manual only) —')}</option>
                {(agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>

          {NEEDS_EXTERNAL_ID[type] && (
            <div>
              <label className={labelCls}>{NEEDS_EXTERNAL_ID[type]}</label>
              <input value={externalId} onChange={(e) => setExternalId(e.target.value)} className={inputCls} placeholder={NEEDS_EXTERNAL_ID[type]} />
            </div>
          )}

          {SECRET_FIELDS[type].length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {SECRET_FIELDS[type].map((key) => (
                <div key={key}>
                  <label className={labelCls}>{key}</label>
                  <input
                    type="password"
                    value={secrets[key] ?? ''}
                    onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
                    className={inputCls}
                    placeholder="••••••••"
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>
          )}
          {type === 'WEBCHAT' && (
            <p className="text-xs text-slate-400">
              {t('channels.webchatHint', 'No credentials needed — a public embed snippet is generated after you save.')}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={() => create.mutate()}
              disabled={create.isPending || !name}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {create.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(channels ?? []).map((c) => (
          <div key={c.id} className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <ChatBubbleLeftRightIcon className="w-5 h-5 text-primary" />
                <div>
                  <div className="font-medium text-slate-900 flex items-center gap-2">
                    {c.name}
                    <span className="text-xs uppercase text-slate-400">{c.type}</span>
                    {c.lastVerifiedAt && <CheckBadgeIcon className="w-4 h-4 text-emerald-500" />}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {c.configuredSecrets.length > 0
                      ? `${t('channels.secretsSet', 'credentials set')}: ${c.configuredSecrets.join(', ')}`
                      : c.type === 'WEBCHAT'
                        ? t('channels.public', 'public web chat')
                        : t('channels.noSecrets', 'no credentials yet')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => verify.mutate(c.id)} className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                  {t('channels.verify', 'Verify')}
                </button>
                <button onClick={() => remove.mutate(c.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50">
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
            {c.type === 'WEBCHAT' && c.widgetKey && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <div className="text-xs text-slate-500 mb-1">{t('channels.embed', 'Embed snippet (paste before </body>)')}</div>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 flex-1 break-all">
                    {embedSnippet(c.widgetKey)}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(embedSnippet(c.widgetKey!));
                      toast.success(t('common.copied', 'Copied'));
                    }}
                    className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                  >
                    <ClipboardIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {(channels ?? []).length === 0 && !showForm && (
          <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">
            {t('channels.empty', 'No channels yet — connect one so customers can message you.')}
          </div>
        )}
      </div>
    </div>
  );
}
