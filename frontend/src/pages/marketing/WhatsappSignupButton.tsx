import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MessageCircle } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { Button } from '@/components/ui/Button';

interface SignupConfig {
  configured: boolean;
  appId: string | null;
  configId: string | null;
  graphVersion: string;
}

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

// Load + init the Facebook JS SDK exactly once per page (subsequent calls reuse
// the same promise). The SDK is only fetched when a configured tenant clicks
// Connect — never on page load.
let fbSdkPromise: Promise<void> | null = null;
function loadFbSdk(appId: string, version: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.FB) return Promise.resolve();
  if (fbSdkPromise) return fbSdkPromise;
  fbSdkPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Failed to load Facebook SDK'));
    document.body.appendChild(s);
  });
  return fbSdkPromise;
}

/**
 * One-click WhatsApp connect for a TENANT via Meta's Embedded Signup. The FB SDK
 * opens Meta's hosted flow (the tenant picks/creates their WABA + phone); a
 * window `message` event carries the WABA + phone-number ids, and FB.login
 * returns a short-lived `code`. We POST both to the backend, which exchanges the
 * code for a business token and provisions the WHATSAPP channel — no manual
 * token handling by the tenant. Inert (disabled) until an admin sets the signup
 * config id on the platform.
 */
export function WhatsappSignupButton() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const session = useRef<{ phoneNumberId?: string; wabaId?: string }>({});
  const [launching, setLaunching] = useState(false);

  const { data: cfg } = useQuery<SignupConfig>({
    queryKey: ['marketing', 'channels', 'wa-signup-config'],
    queryFn: () =>
      marketingApi.get('/channels/whatsapp/embedded-signup/config').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });

  // Capture the WABA + phone-number ids Meta posts during Embedded Signup.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin || 'http://x').hostname)) return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.type === 'WA_EMBEDDED_SIGNUP' && parsed?.data) {
          session.current = {
            phoneNumberId: parsed.data.phone_number_id,
            wabaId: parsed.data.waba_id,
          };
        }
      } catch {
        /* not the embedded-signup event */
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const complete = useMutation({
    mutationFn: (payload: { code: string; wabaId?: string; phoneNumberId: string }) =>
      marketingApi.post('/channels/whatsapp/embedded-signup', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'channels'] });
      toast.success(t('channels.waConnected', 'WhatsApp connected'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('channels.waFailed', 'WhatsApp connect failed')),
  });

  const onClick = useCallback(async () => {
    if (!cfg?.configured || !cfg.appId || !cfg.configId) return;
    setLaunching(true);
    try {
      await loadFbSdk(cfg.appId, cfg.graphVersion || 'v19.0');
      session.current = {};
      window.FB.login(
        (resp: any) => {
          const code = resp?.authResponse?.code as string | undefined;
          const { phoneNumberId, wabaId } = session.current;
          if (!code) return; // tenant closed/cancelled the dialog
          if (!phoneNumberId) {
            toast.error(
              t('channels.waNoPhone', 'Could not read the WhatsApp number from sign-up — try again'),
            );
            return;
          }
          complete.mutate({ code, wabaId, phoneNumberId });
        },
        {
          config_id: cfg.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
        },
      );
    } catch {
      toast.error(t('channels.waSdkFailed', 'Could not open the WhatsApp sign-up'));
    } finally {
      setLaunching(false);
    }
  }, [cfg, complete, t]);

  if (!cfg) return null;
  const disabled = !cfg.configured || complete.isPending;

  return (
    <Button
      variant="outline"
      size="md"
      onClick={onClick}
      disabled={disabled}
      loading={launching || complete.isPending}
      title={
        cfg.configured
          ? undefined
          : t('channels.waSignupNotConfigured', 'An admin must configure WhatsApp sign-up first')
      }
    >
      <MessageCircle className="h-4 w-4" />
      {t('channels.connectWhatsApp', 'Connect WhatsApp')}
    </Button>
  );
}
