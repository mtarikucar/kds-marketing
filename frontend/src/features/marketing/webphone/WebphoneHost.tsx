import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, PhoneCall, PhoneOff } from 'lucide-react';
import marketingApi from '../api/marketingApi';
import { createWebphone, type WebphoneState, type WebphoneConfig } from './webphone.store';
import CopilotPanel from './CopilotPanel';

/**
 * App-wide webphone host: mounted once in MarketingLayout so the rep's NetGSM
 * dahili stays REGISTERED on every page (not just the Telephony Settings panel).
 * That's what makes click-to-dial work — NetGSM `originate` rings the extension
 * first, and the webphone (registered here, auto-answering inbound) picks it up
 * and bridges the customer. Inert (renders nothing) when telephony/webphone isn't
 * configured for the rep. Shows a small status pill; surfaces an in-call hang-up.
 */
export default function WebphoneHost() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const wpRef = useRef<ReturnType<typeof createWebphone> | null>(null);
  const [state, setState] = useState<WebphoneState>({ status: 'idle' });

  const { data: cfg } = useQuery<WebphoneConfig | null>({
    queryKey: ['marketing', 'telephony', 'webphone-config'],
    queryFn: () => marketingApi.get('/telephony/webphone-config').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!cfg || !audioRef.current || wpRef.current) return;
    const wp = createWebphone(audioRef.current);
    wpRef.current = wp;
    const unsub = wp.subscribe(setState);
    wp.start(cfg);
    return () => {
      unsub();
      wp.stop();
      wpRef.current = null;
    };
  }, [cfg]);

  // Nothing to mount until the rep has a webphone config.
  if (!cfg) return null;

  const dot =
    state.status === 'registered' || state.status === 'incall'
      ? 'bg-green-500'
      : state.status === 'failed'
        ? 'bg-red-500'
        : 'bg-amber-500';
  const label =
    state.status === 'incall'
      ? 'Görüşmede'
      : state.status === 'registered'
        ? 'Telefon hazır'
        : state.status === 'registering'
          ? 'Bağlanıyor…'
          : state.status === 'failed'
            ? 'Telefon bağlanamadı'
            : 'Telefon';

  return (
    <>
      {/* Live-call copilot — only while a call is connected. Self-contained:
          listens to the rep's mic (Web Speech API) and surfaces AI suggestions. */}
      {state.status === 'incall' && (
        <div className="fixed bottom-14 right-3 z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface p-3 shadow-lg">
          <CopilotPanel />
        </div>
      )}
      <div className="fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 shadow-md">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        {state.status === 'incall' ? (
          <PhoneCall className="h-4 w-4 text-foreground" aria-hidden="true" />
        ) : (
          <Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="text-caption text-foreground">{label}</span>
        {state.status === 'incall' && (
          <button
            type="button"
            onClick={() => wpRef.current?.hangup()}
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-micro text-danger-foreground hover:bg-danger/90"
          >
            <PhoneOff className="h-3 w-3" aria-hidden="true" /> Kapat
          </button>
        )}
      </div>
      <audio ref={audioRef} autoPlay />
    </>
  );
}
