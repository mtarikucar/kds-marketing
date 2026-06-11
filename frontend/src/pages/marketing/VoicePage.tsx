import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PhoneIcon, SparklesIcon, UserIcon, ChevronLeftIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface VoiceCall { id: string; fromNumber: string; toNumber: string; status: string; turns: number; createdAt: string }
interface Turn { role: string; text: string; createdAt: string }

export default function VoicePage() {
  const { t } = useTranslation('marketing');
  const [selected, setSelected] = useState<string | null>(null);

  const { data: calls } = useQuery<VoiceCall[]>({
    queryKey: ['marketing', 'voice', 'calls'],
    queryFn: () => marketingApi.get('/voice/calls').then((r) => r.data),
    refetchInterval: 20_000,
  });
  const { data: transcript } = useQuery<Turn[]>({
    queryKey: ['marketing', 'voice', 'transcript', selected],
    queryFn: () => marketingApi.get(`/voice/calls/${selected}/transcript`).then((r) => r.data),
    enabled: !!selected,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('voice.title', 'Voice AI')}</h1>
        <p className="text-sm text-slate-500">{t('voice.subtitle', 'AI answers your phone (Twilio), grounded on an agent + your knowledge base. Configure the number under Channels (type VOICE).')}</p>
      </div>

      <div className="flex gap-0 sm:gap-4 h-[calc(100vh-12rem)]">
        <div className={`${selected ? 'hidden sm:block' : 'block'} w-full sm:w-80 sm:shrink-0 bg-white rounded-xl border border-slate-200 overflow-y-auto divide-y divide-slate-50`}>
          {(calls ?? []).map((c) => (
            <button key={c.id} onClick={() => setSelected(c.id)} className={`w-full text-left p-3 hover:bg-slate-50 ${selected === c.id ? 'bg-primary/5' : ''}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm text-slate-900 flex items-center gap-1.5"><PhoneIcon className="w-4 h-4 text-primary" />{c.fromNumber || t('voice.unknown', 'Unknown')}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700' : c.status === 'IN_PROGRESS' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>{c.status}</span>
              </div>
              <div className="text-xs text-slate-400 mt-0.5">{c.turns} {t('voice.turns', 'turns')} · {new Date(c.createdAt).toLocaleString()}</div>
            </button>
          ))}
          {(calls ?? []).length === 0 && <div className="p-6 text-center text-xs text-slate-400">{t('voice.empty', 'No AI calls yet.')}</div>}
        </div>

        <div className={`${selected ? 'block' : 'hidden sm:block'} w-full sm:w-auto sm:flex-1 bg-white rounded-xl border border-slate-200 overflow-y-auto p-4`}>
          {!selected ? (
            <div className="h-full flex items-center justify-center text-sm text-slate-400">{t('voice.selectPrompt', 'Select a call to see the transcript.')}</div>
          ) : (
            <div className="space-y-3">
              <button
                onClick={() => setSelected(null)}
                className="sm:hidden flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
              >
                <ChevronLeftIcon className="w-4 h-4" /> {t('voice.back', 'Calls')}
              </button>
              {(transcript ?? []).map((tt, i) => (
                <div key={i} className={`flex ${tt.role === 'AI' ? 'justify-start' : tt.role === 'CUSTOMER' ? 'justify-end' : 'justify-center'}`}>
                  <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${tt.role === 'AI' ? 'bg-slate-100 text-slate-800' : tt.role === 'CUSTOMER' ? 'bg-primary text-primary-foreground' : 'bg-amber-50 text-amber-700 text-xs'}`}>
                    <div className="flex items-center gap-1 opacity-70 text-[10px] mb-0.5">
                      {tt.role === 'AI' ? <SparklesIcon className="w-3 h-3" /> : tt.role === 'CUSTOMER' ? <UserIcon className="w-3 h-3" /> : null}{tt.role}
                    </div>
                    {tt.text}
                  </div>
                </div>
              ))}
              {(transcript ?? []).length === 0 && <div className="text-sm text-slate-400">{t('voice.noTranscript', 'No transcript for this call.')}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
