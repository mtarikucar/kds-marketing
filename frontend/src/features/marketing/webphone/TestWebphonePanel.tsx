import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import marketingApi from '../api/marketingApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { createWebphone, type WebphoneState, type WebphoneConfig } from './webphone.store';

export default function TestWebphonePanel() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const wpRef = useRef<ReturnType<typeof createWebphone> | null>(null);
  const [state, setState] = useState<WebphoneState>({ status: 'idle' });
  const [number, setNumber] = useState('');

  const { data: cfg } = useQuery<WebphoneConfig | null>({
    queryKey: ['marketing', 'telephony', 'webphone-config'],
    queryFn: () => marketingApi.get('/telephony/webphone-config').then((r) => r.data),
  });

  useEffect(() => {
    if (!cfg || !audioRef.current || wpRef.current) return;
    const wp = createWebphone(audioRef.current);
    wpRef.current = wp;
    const unsub = wp.subscribe(setState);
    wp.start(cfg);
    return () => { unsub(); wp.stop(); wpRef.current = null; };
  }, [cfg]);

  if (!cfg) {
    return (
      <Card><CardContent className="p-5">
        <p className="text-caption text-muted-foreground">Webphone config yok — önce Netsantral creds + WSS adresi + bu kullanıcıya dahili/şifre atayın.</p>
      </CardContent></Card>
    );
  }

  return (
    <Card><CardContent className="p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">Test Webphone</span>
        <span className="text-caption text-muted-foreground">durum: {state.status}{state.error ? ` (${state.error})` : ''}</span>
      </div>
      <div className="flex items-center gap-2">
        <PhoneInput value={number} onChange={(e) => setNumber(e.target.value)} />
        <Button disabled={state.status !== 'registered' || !number.trim()} onClick={() => wpRef.current?.call(number).catch((e) => toast.error(e?.message ?? 'call failed'))}>Ara</Button>
        <Button variant="outline" disabled={state.status !== 'incall'} onClick={() => wpRef.current?.hangup()}>Kapat</Button>
      </div>
      <audio ref={audioRef} autoPlay />
    </CardContent></Card>
  );
}
