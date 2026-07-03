import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Phone, PhoneCall } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import marketingApi from '../../../features/marketing/api/marketingApi';

interface TelephonyConfigView {
  status?: string;
  trunk?: string | null;
  pbxnum?: string | null;
  wssUrl?: string | null;
  sipDomain?: string | null;
  configuredSecrets: string[];
}
interface Rep {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  phone?: string | null;
  dahili?: string | null;
}

const telephonyKey = ['marketing', 'telephony', 'config'] as const;

/**
 * "Phone (Netsantral)" — NetGSM cloud-PBX click-to-call, fully configurable from
 * the Account Center (reuses every /marketing/telephony endpoint). Workspace
 * credentials + the outbound 0850 trunk enable click-to-call; wss/SIP enable the
 * in-browser webphone; the per-rep table gives each rep a phone (bridge) and/or a
 * dahili+SIP password (webphone). Distinct from the AI Voice provider.
 */
export function TelephonyCard() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: cfg, isLoading, isError } = useQuery<TelephonyConfigView | null>({
    queryKey: telephonyKey,
    queryFn: () => marketingApi.get('/telephony/config').then((r) => r.data),
  });

  const hasCreds =
    !!cfg && cfg.configuredSecrets?.includes('username') && cfg.configuredSecrets?.includes('password');
  const connected = !!cfg && cfg.status === 'ACTIVE' && hasCreds && !!cfg.trunk;
  const webphoneReady = !!cfg?.wssUrl && !!cfg?.sipDomain;

  const badge = isError
    ? { tone: 'danger' as const, label: t('accounts.loadError', "Couldn't load") }
    : !cfg
      ? { tone: 'neutral' as const, label: t('accounts.notConnected', 'Not connected') }
      : connected
        ? { tone: 'success' as const, label: t('accounts.tel.connected', 'Connected') }
        : { tone: 'warning' as const, label: t('accounts.tel.incomplete', 'Incomplete') };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted"
              style={{ color: '#EA580C' }}
            >
              <PhoneCall className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-medium text-foreground">{t('accounts.tel.title', 'Phone (Netsantral)')}</p>
              <p className="text-caption text-muted-foreground">
                {connected
                  ? webphoneReady
                    ? t('accounts.tel.webphoneReady', 'Click-to-call + webphone ready')
                    : t('accounts.tel.clickToCall', 'Click-to-call ready')
                  : t('accounts.tel.subtitle', 'NetGSM cloud PBX — call customers from the CRM')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isLoading ? (
              <Skeleton className="h-5 w-20 rounded-full" />
            ) : (
              <Badge tone={badge.tone} size="sm">{badge.label}</Badge>
            )}
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Phone className="h-4 w-4" />
              {connected ? t('accounts.tel.manage', 'Manage') : t('accounts.setUp', 'Set up')}
            </Button>
          </div>
        </div>
      </CardContent>

      {open && (
        <TelephonyDialog
          cfg={cfg ?? null}
          onOpenChange={setOpen}
          onSaved={() => qc.invalidateQueries({ queryKey: telephonyKey })}
        />
      )}
    </Card>
  );
}

function TelephonyDialog({
  cfg,
  onOpenChange,
  onSaved,
}: {
  cfg: TelephonyConfigView | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('marketing');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [trunk, setTrunk] = useState(cfg?.trunk ?? '');
  const [wssUrl, setWssUrl] = useState(cfg?.wssUrl ?? '');
  const [sipDomain, setSipDomain] = useState(cfg?.sipDomain ?? '');

  const { data: reps } = useQuery<Rep[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
  });

  useEffect(() => {
    setTrunk(cfg?.trunk ?? '');
    setWssUrl(cfg?.wssUrl ?? '');
    setSipDomain(cfg?.sipDomain ?? '');
  }, [cfg]);

  const save = useMutation({
    mutationFn: () =>
      marketingApi.put('/telephony/config', {
        secrets: {
          ...(username.trim() ? { username: username.trim() } : {}),
          ...(password ? { password } : {}),
        },
        trunk: trunk.trim() || undefined,
        wssUrl: wssUrl.trim() || undefined,
        sipDomain: sipDomain.trim() || undefined,
      }),
    onSuccess: () => {
      onSaved();
      setUsername('');
      setPassword('');
      toast.success(t('accounts.tel.saved', 'Telephony saved'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || t('accounts.tel.saveFailed', 'Could not save')),
  });

  const test = useMutation({
    mutationFn: () => marketingApi.post('/telephony/cdr/test', {}),
    onSuccess: () => toast.success(t('accounts.tel.testOk', 'Credentials verified with NetGSM')),
    onError: (e: any) => toast.error(e?.response?.data?.message || t('accounts.tel.testFailed', 'Verification failed — check the credentials')),
  });

  const hasUser = cfg?.configuredSecrets?.includes('username');
  const hasPass = cfg?.configuredSecrets?.includes('password');

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('accounts.tel.title', 'Phone (Netsantral)')}</DialogTitle>
          <DialogDescription>
            {t('accounts.tel.dialogDesc', 'Enter your NetGSM Netsantral API credentials and the 0850 trunk. Add the WebRTC URLs for the in-browser webphone, and give each rep a phone or extension below.')}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <section className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t('accounts.tel.workspace', 'Workspace credentials')}</p>
            <Input
              aria-label={t('accounts.tel.username', 'NetGSM username (abone no)')}
              placeholder={hasUser ? t('accounts.tel.usernameSet', 'NetGSM username (saved — leave blank to keep)') : t('accounts.tel.username', 'NetGSM username (abone no)')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              type="password"
              aria-label={t('accounts.tel.password', 'API sub-user password')}
              placeholder={hasPass ? t('accounts.tel.passwordSet', 'API password (saved — leave blank to keep)') : t('accounts.tel.password', 'API sub-user password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input aria-label={t('accounts.tel.trunk', 'Outbound trunk / caller-id (0850…)')} placeholder={t('accounts.tel.trunk', 'Outbound trunk / caller-id (0850…)')} value={trunk} onChange={(e) => setTrunk(e.target.value)} />
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t('accounts.tel.webphone', 'In-browser webphone (optional)')}</p>
            <Input aria-label={t('accounts.tel.wssUrl', 'WebRTC WSS URL')} placeholder="wss://sip5.netsantral.com:8089/ws" value={wssUrl} onChange={(e) => setWssUrl(e.target.value)} />
            <Input aria-label={t('accounts.tel.sipDomain', 'SIP domain')} placeholder="sip5.netsantral.com" value={sipDomain} onChange={(e) => setSipDomain(e.target.value)} />
          </section>

          <div className="flex gap-2">
            <Button onClick={() => save.mutate()} loading={save.isPending}>{t('common.save', 'Save')}</Button>
            <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}>{t('accounts.tel.test', 'Verify credentials')}</Button>
          </div>

          <section className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium text-foreground">{t('accounts.tel.reps', 'Who can call')}</p>
            <p className="text-caption text-muted-foreground">
              {t('accounts.tel.repsHint', 'Give each rep their own phone (bridge dialing — works immediately) and/or a dahili + SIP password (in-browser webphone).')}
            </p>
            <div className="space-y-1.5">
              {(reps ?? []).map((r) => (
                <RepRow key={r.id} rep={r} onSaved={onSaved} />
              ))}
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepRow({ rep, onSaved }: { rep: Rep; onSaved: () => void }) {
  const { t } = useTranslation('marketing');
  const [phone, setPhone] = useState(rep.phone ?? '');
  const [dahili, setDahili] = useState(rep.dahili ?? '');
  const [sipPassword, setSipPassword] = useState('');

  const save = useMutation({
    mutationFn: () =>
      marketingApi.patch(`/telephony/users/${rep.id}/dahili`, {
        phone: phone.trim() || null,
        dahili: dahili.trim() || null,
        ...(sipPassword ? { sipPassword } : {}),
      }),
    onSuccess: () => {
      onSaved();
      setSipPassword('');
      toast.success(t('accounts.tel.repSaved', 'Rep updated'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || t('accounts.tel.saveFailed', 'Could not save')),
  });

  const name = `${rep.firstName ?? ''} ${rep.lastName ?? ''}`.trim() || rep.email;

  return (
    <div className="space-y-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => save.mutate()} loading={save.isPending}>
          {t('common.save', 'Save')}
        </Button>
      </div>
      {/* Inputs wrap/fill on mobile instead of overflowing a fixed-width row. */}
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 basis-32" aria-label={t('accounts.tel.phoneFor', { defaultValue: 'Phone for {{name}}', name })} placeholder={t('accounts.tel.phone', 'Phone')} value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input className="w-20 shrink-0" aria-label={t('accounts.tel.dahiliFor', { defaultValue: 'Dahili for {{name}}', name })} placeholder={t('accounts.tel.dahili', 'Dahili')} value={dahili} onChange={(e) => setDahili(e.target.value)} />
        <Input className="min-w-0 flex-1 basis-28" type="password" aria-label={t('accounts.tel.sipFor', { defaultValue: 'SIP password for {{name}}', name })} placeholder={t('accounts.tel.sip', 'SIP pass')} value={sipPassword} onChange={(e) => setSipPassword(e.target.value)} />
      </div>
    </div>
  );
}
