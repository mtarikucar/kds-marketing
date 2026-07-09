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
import { Callout, type CalloutTone } from '@/components/ui/Callout';
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

interface BalanceResult {
  ok: boolean;
  /** true = NetGSM authenticated the creds; false = rejected; null = couldn't reach NetGSM. */
  credsValid: boolean | null;
  code: string | null;
  credit: string | null;
  packages: Array<{ name: string; remaining: string | null }>;
  message: string | null;
}
interface VerifyResult {
  configured: boolean;
  balance: BalanceResult | null;
  cdr: { httpStatus: number; body: unknown } | { skipped: string } | { error: string };
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

/**
 * True only when the CDR leg genuinely confirmed (an httpStatus 2xx AND no
 * NetGSM error `code` in the body) — see the CDR-note fix note below for why
 * `'httpStatus' in cdr` alone is not sufficient.
 */
function cdrConfirmedOk(cdr: VerifyResult['cdr']): boolean {
  if (!cdr || !('httpStatus' in cdr)) return false; // {skipped}/{error} — transport-level failure
  const { httpStatus, body } = cdr;
  if (httpStatus < 200 || httpStatus >= 300) return false;
  const errorCode = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined;
  return errorCode == null;
}

/**
 * Disambiguate the /telephony/verify response into a tone + localized headline
 * + optional secondary detail line:
 * - The headline ALWAYS comes from an i18n key — `balance.message` is a raw
 *   provider string (from the backend's netgsm-error map) that is always in
 *   Turkish, regardless of the viewer's locale, so it must never displace the
 *   localized copy as the primary message.
 * - `balance.message`, when present, is still useful diagnostics, so it's
 *   rendered underneath as a smaller secondary `detail` line instead.
 * - `configured === false` (no Netsantral credentials saved yet) gets its own
 *   distinct copy instead of folding into the generic "unreachable" bucket.
 * - The /balance probe is the real credential check (works from any IP); the
 *   CDR leg is only ever reachable from NetGSM's allow-listed prod IP, so its
 *   absence is expected almost everywhere except production and gets its own
 *   informational note rather than being folded into the main verdict.
 *
 * CDR-note fix (Phase-0 deferral, NetGSM Phase 3 Task 6): `cdr.testFetch`
 * (backend `CallCdrSyncService.testFetch` -> `NetgsmCdrClient.fetchRaw`)
 * ALWAYS returns `{httpStatus, body}` as long as NetGSM's server answered at
 * all — including a pre-auth rejection off-prod, which NetGSM returns as
 * HTTP 200 with an error envelope `{code: "30", error: "..."}` in the body
 * (see `netgsm-cdr.client.ts`'s own comment on that envelope shape). So
 * `'httpStatus' in cdr` alone is NOT proof the CDR leg actually authenticated
 * — it only proves the transport didn't fail. The note must also show
 * whenever the body carries a NetGSM error `code`, or the HTTP status itself
 * isn't 2xx.
 */
function describeVerifyResult(
  result: VerifyResult,
  t: (key: string, fallback: string) => string,
): { tone: CalloutTone; message: string; detail: string | null; showCdrNote: boolean } {
  if (!result.configured) {
    return {
      tone: 'warning',
      message: t('accounts.tel.verify.notConfigured', 'Save your Netsantral credentials first, then verify.'),
      detail: null,
      showCdrNote: false,
    };
  }

  const credsValid = result.balance?.credsValid ?? null;
  const showCdrNote = !cdrConfirmedOk(result.cdr);
  const detail = result.balance?.message || null;

  if (credsValid === true) {
    const credit = result.balance?.credit;
    return {
      tone: 'success',
      message:
        t('accounts.tel.verify.ok', 'Credentials verified with NetGSM') +
        (credit ? ` — ${credit} TL` : ''),
      detail: null,
      showCdrNote,
    };
  }
  if (credsValid === false) {
    return {
      tone: 'danger',
      message: t('accounts.tel.verify.badCreds', 'NetGSM rejected these credentials'),
      detail,
      showCdrNote,
    };
  }
  return {
    tone: 'warning',
    message: t('accounts.tel.verify.unreachable', "Couldn't reach NetGSM — try again in a moment"),
    detail,
    showCdrNote,
  };
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

  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const verify = useMutation({
    mutationFn: () => marketingApi.post<VerifyResult>('/telephony/verify', {}),
    onSuccess: (res) => setVerifyResult(res.data),
    onError: (e: any) => {
      setVerifyResult(null);
      toast.error(e?.response?.data?.message || t('accounts.tel.testFailed', 'Verification failed — check the credentials'));
    },
  });
  const outcome = verifyResult ? describeVerifyResult(verifyResult, t) : null;

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
            <Button variant="outline" onClick={() => verify.mutate()} loading={verify.isPending}>{t('accounts.tel.test', 'Verify credentials')}</Button>
          </div>

          {outcome && (
            <Callout tone={outcome.tone}>
              <p>{outcome.message}</p>
              {outcome.detail && (
                <p className="text-caption text-muted-foreground">{outcome.detail}</p>
              )}
              {outcome.showCdrNote && (
                <p className="text-caption text-muted-foreground">
                  {t('accounts.tel.verify.cdrProdOnly', 'Call log (CDR) can only be confirmed from the production server IP')}
                </p>
              )}
            </Callout>
          )}

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
