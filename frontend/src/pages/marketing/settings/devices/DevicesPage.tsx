import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Smartphone, Clipboard, Pause, Play, Stethoscope } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import { copyToClipboard } from '../../../../lib/clipboard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Disclosure } from '@/components/ui/Disclosure';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';

interface DeviceRow {
  id: string;
  label: string;
  platform: string;
  mode: 'MANUAL' | 'AUTO';
  status: 'ACTIVE' | 'PAUSED';
  lastSeenAt?: string | null;
  pairedAt?: string | null;
  /** What the bridge found on the cable, reported on every heartbeat. */
  properties?: {
    serial?: string;
    model?: string;
    androidVersion?: string;
    screen?: string;
    /** The desktop app's own version, reported on every heartbeat. */
    bridgeVersion?: string;
  } | null;
}

interface CommandRow {
  id: string;
  kind: string;
  status: string;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
  result?: { screenshotUrl?: string; screenshotUnavailable?: string } | null;
}

/** The bridge posts a heartbeat every 30s, so 90s of silence is a closed laptop
 *  or an unplugged cable. Saying that out loud is the whole value of the badge:
 *  a queue that never drains looks identical to a phone that refuses. */
const ONLINE_MS = 90_000;
const isOnline = (d: DeviceRow) =>
  Boolean(d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < ONLINE_MS);

/**
 * The oldest desktop app that understands everything the server can now send.
 *
 * Duplicated from the server's MIN_BRIDGE_VERSION rather than fetched, because
 * this is a hint on a settings page and a round trip to learn it would be a
 * round trip nobody is waiting for. The server's copy is the one that governs
 * `jeeta.list_devices`; if they drift, this badge is early or late by one
 * release and nothing breaks.
 */
const MIN_BRIDGE = [0, 2, 0];
const isOutdated = (d: DeviceRow): boolean => {
  const v = d.properties?.bridgeVersion;
  // No version at all means an app built before it reported one.
  if (!v || !/^\d+\.\d+\.\d+/.test(v)) return true;
  const parts = v.split('.').slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== MIN_BRIDGE[i]) return parts[i] < MIN_BRIDGE[i];
  }
  return false;
};

function History({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useQuery<CommandRow[]>({
    queryKey: ['marketing', 'devices', deviceId, 'commands'],
    queryFn: () => marketingApi.get(`/devices/${deviceId}/commands?take=20`).then((r) => r.data),
  });
  const rows = Array.isArray(data) ? data : [];

  if (isLoading) return <p className="text-sm text-muted-foreground">…</p>;
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('devices.noCommands', { defaultValue: 'Nothing has been asked of this phone yet.' })}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <code className="text-xs">{c.kind}</code>
            {c.error && <p className="truncate text-micro text-danger">{c.error}</p>}
            {/* A screenshot nobody can open is a screenshot we did not take.
                The link is the whole point of storing it rather than the
                bytes. */}
            {c.result?.screenshotUrl && (
              <a
                className="text-micro text-primary underline"
                href={c.result.screenshotUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t('devices.openShot', { defaultValue: 'Open the screenshot' })}
              </a>
            )}
            {c.result?.screenshotUnavailable && (
              <p className="truncate text-micro text-muted-foreground">
                {c.result.screenshotUnavailable}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              size="sm"
              tone={
                c.status === 'DONE'
                  ? 'success'
                  : c.status === 'FAILED'
                    ? 'danger'
                    : c.status === 'REFUSED' || c.status === 'EXPIRED'
                      ? 'neutral'
                      : 'warning'
              }
            >
              {c.status}
            </Badge>
            <span className="text-micro text-muted-foreground">
              {fmtDateTime(c.completedAt ?? c.createdAt)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * "It says online" and "it works" are different claims.
 *
 * A heartbeat only proves the desktop app can reach the server. It says
 * nothing about whether the phone is still on the cable, whether `adb` is
 * installed, or whether anyone at the desk is approving anything. This queues
 * the most harmless command there is — read the screen — and waits for a real
 * outcome, which is the only thing that answers the question.
 */
function useProbe(deviceId: string) {
  const [state, setState] = useState<{ status: string; detail?: string } | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setState(null);
    try {
      const { data } = await marketingApi.post(`/devices/${deviceId}/commands`, { kind: 'UI_DUMP' });
      const id = data?.id;
      // Poll the phone's own history rather than a dedicated endpoint: this is
      // the same row an operator sees under "Recent commands", so what the
      // button reports and what that list shows can never disagree.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const { data: rows } = await marketingApi.get(`/devices/${deviceId}/commands?take=10`);
        const row = (Array.isArray(rows) ? rows : []).find((r: CommandRow) => r.id === id);
        if (row && !['QUEUED', 'CLAIMED'].includes(row.status)) {
          const count = (row as { result?: { elements?: unknown[] } }).result?.elements?.length;
          setState({
            status: row.status,
            detail: row.error ?? (typeof count === 'number' ? `${count} öğe okundu` : undefined),
          });
          return;
        }
      }
      setState({ status: 'QUEUED' });
    } catch (e: any) {
      setState({ status: 'FAILED', detail: e?.response?.data?.message ?? String(e) });
    } finally {
      setRunning(false);
    }
  };

  return { state, running, run };
}

function Probe({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('marketing');
  const { state, running, run } = useProbe(deviceId);

  const message = !state
    ? null
    : state.status === 'DONE'
      ? t('devices.probeOk', {
          defaultValue: 'Works — the phone read its own screen. {{detail}}',
          detail: state.detail ?? '',
        })
      : state.status === 'REFUSED'
        ? t('devices.probeRefused', {
            defaultValue: 'Someone at the phone declined. The chain works; they said no.',
          })
        : state.status === 'QUEUED'
          ? t('devices.probeStuck', {
              defaultValue:
                'Nobody collected it. The desktop app is not running, or it is pointed at a different device id.',
            })
          : t('devices.probeFailed', {
              defaultValue: 'The phone could not do it: {{detail}}',
              detail: state.detail ?? '',
            });

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => void run()} disabled={running}>
        <Stethoscope className="h-4 w-4" aria-hidden="true" />
        {running
          ? t('devices.probing', { defaultValue: 'Testing…' })
          : t('devices.probe', { defaultValue: 'Test the connection' })}
      </Button>
      {message && (
        <span
          className={
            state?.status === 'DONE' ? 'text-micro text-success' : 'text-micro text-muted-foreground'
          }
        >
          {message}
        </span>
      )}
    </div>
  );
}

/**
 * Paired phones — the surface that makes the desktop bridge usable at all.
 *
 * A phone is added HERE first, because pairing is what produces the device id
 * the desktop app asks for. Without this page that id existed only as a row in
 * the database, and a capability nobody can reach is a capability we do not
 * have.
 *
 * The two controls that matter are deliberately not buried in a menu. AUTO is
 * the moment a phone stops asking a person before it acts, so it is a switch
 * with its consequence written beside it. Pause EMPTIES the queue rather than
 * holding it — anything waiting is dropped — which is why it confirms and why
 * the confirmation says so in those words.
 */
export default function DevicesPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [serial, setSerial] = useState('');
  const [autoTarget, setAutoTarget] = useState<DeviceRow | null>(null);
  const [pauseTarget, setPauseTarget] = useState<DeviceRow | null>(null);

  const { data, isLoading } = useQuery<DeviceRow[]>({
    queryKey: ['marketing', 'devices'],
    queryFn: () => marketingApi.get('/devices').then((r) => r.data),
  });
  const devices = Array.isArray(data) ? data : [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['marketing', 'devices'] });
  const fail = (e: any, fallback: string) => toast.error(e?.response?.data?.message ?? fallback);

  const createMutation = useMutation({
    mutationFn: () =>
      marketingApi.post('/devices', { label: label.trim(), serial: serial.trim() || undefined }),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      setLabel('');
      setSerial('');
    },
    onError: (e) => fail(e, t('devices.addFailed', { defaultValue: 'Could not add the phone' })),
  });

  const modeMutation = useMutation({
    mutationFn: (v: { id: string; mode: 'MANUAL' | 'AUTO' }) =>
      marketingApi.post(`/devices/${v.id}/mode`, { mode: v.mode }),
    onSuccess: () => {
      invalidate();
      setAutoTarget(null);
    },
    onError: (e) => fail(e, t('devices.modeFailed', { defaultValue: 'Could not change the mode' })),
  });

  const statusMutation = useMutation({
    mutationFn: (v: { id: string; status: 'ACTIVE' | 'PAUSED' }) =>
      marketingApi.post(`/devices/${v.id}/status`, { status: v.status }),
    onSuccess: () => {
      invalidate();
      setPauseTarget(null);
    },
    onError: (e) =>
      fail(e, t('devices.statusFailed', { defaultValue: 'Could not change the status' })),
  });

  const copy = async (value: string) => {
    if (await copyToClipboard(value)) toast.success(t('common.copied', { defaultValue: 'Copied' }));
    else
      toast.error(
        t('common.copyFailed', { defaultValue: 'Could not copy — select it and copy manually.' }),
      );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        embedded={embedded}
        title={t('devices.title', { defaultValue: 'Paired phones' })}
        description={t('devices.subtitle', {
          defaultValue:
            'A phone Jeeta can act on — to put a first WhatsApp message on screen, open a profile, or place a call.',
        })}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('devices.add', { defaultValue: 'Add phone' })}
          </Button>
        }
      />

      <Callout tone="info" title={t('devices.how', { defaultValue: 'Three things are needed' })}>
        <ol className="ml-4 list-decimal space-y-1 text-sm">
          <li>
            {t('devices.how1', {
              defaultValue:
                'The Jeeta desktop app, running on the computer the phone is plugged into by USB.',
            })}
          </li>
          <li>
            {t('devices.how2', {
              defaultValue:
                'An API key from the API keys tab — the desktop app signs in with it. Give it TWO things, because two different callers use it: the plain "write" scope, which is what the desktop app itself needs, AND the granular "campaigns.send" + "reports.read" scopes, which are what Claude needs to command the phone. A key with only read/write runs the bridge and leaves Claude unable to see the phone at all.',
            })}
          </li>
          <li>
            {t('devices.how3', { defaultValue: 'The device id below, pasted into the desktop app.' })}
          </li>
        </ol>
      </Callout>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : !devices.length ? (
        <EmptyState
          icon={<Smartphone className="h-10 w-10" />}
          title={t('devices.empty', { defaultValue: 'No phone paired' })}
          description={t('devices.emptyHint', {
            defaultValue:
              'Add one here first — pairing is what produces the id the desktop app asks for.',
          })}
          action={
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('devices.add', { defaultValue: 'Add phone' })}
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {devices.map((d) => (
            <section key={d.id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{d.label}</p>
                    <Badge size="sm" tone={isOnline(d) ? 'success' : 'neutral'}>
                      {isOnline(d)
                        ? t('devices.online', { defaultValue: 'Bridge online' })
                        : t('devices.offline', { defaultValue: 'Bridge offline' })}
                    </Badge>
                    {d.status === 'PAUSED' && (
                      <Badge size="sm" tone="warning">
                        {t('devices.paused', { defaultValue: 'Paused' })}
                      </Badge>
                    )}
                    {/* An old desktop app is ONLINE and healthy and will refuse
                        every command added since it shipped. Without this the
                        only signal is that refusal, which arrives at the worst
                        moment — when somebody finally used the new thing. */}
                    {isOnline(d) && isOutdated(d) && (
                      <Badge size="sm" tone="warning">
                        {t('devices.outdated', { defaultValue: 'Desktop app is out of date' })}
                      </Badge>
                    )}
                  </div>
                  {/* Which handset is on the cable. A workspace with two
                      phones cannot otherwise tell one row from the other, and
                      "the wrong phone messaged a customer" is not a mistake
                      anybody wants to make twice. */}
                  {d.properties?.model && (
                    <p className="mt-1 text-micro text-muted-foreground">
                      {[
                        d.properties.model,
                        d.properties.androidVersion && `Android ${d.properties.androidVersion}`,
                        d.properties.serial,
                        d.properties.bridgeVersion && `Jeeta Masaüstü ${d.properties.bridgeVersion}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  {isOnline(d) && isOutdated(d) && (
                    <p className="mt-1 text-micro text-warning">
                      {t('devices.outdatedHint', {
                        defaultValue:
                          'This desktop app is older than the commands Jeeta can now send. It will refuse the newer ones — update it before relying on this phone.',
                      })}
                    </p>
                  )}
                  <p className="mt-1 text-micro text-muted-foreground">
                    {d.lastSeenAt
                      ? t('devices.lastSeen', {
                          defaultValue: 'Last seen {{when}}',
                          when: fmtDateTime(d.lastSeenAt),
                        })
                      : t('devices.neverSeen', {
                          defaultValue: 'The desktop app has never connected with this id.',
                        })}
                  </p>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    d.status === 'ACTIVE'
                      ? setPauseTarget(d)
                      : statusMutation.mutate({ id: d.id, status: 'ACTIVE' })
                  }
                  // Per-row, not per-mutation: a shared isPending disables every
                  // phone's button while one of them is saving.
                  disabled={statusMutation.isPending && statusMutation.variables?.id === d.id}
                >
                  {d.status === 'ACTIVE' ? (
                    <>
                      <Pause className="h-4 w-4" aria-hidden="true" />
                      {t('devices.pause', { defaultValue: 'Pause' })}
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" aria-hidden="true" />
                      {t('devices.resume', { defaultValue: 'Resume' })}
                    </>
                  )}
                </Button>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <span className="shrink-0 text-micro text-muted-foreground">
                  {t('devices.id', { defaultValue: 'Device id' })}
                </span>
                <code className="min-w-0 flex-1 truncate rounded border border-border bg-surface px-2 py-1 text-xs">
                  {d.id}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('common.copy', { defaultValue: 'Copy' })}
                  onClick={() => copy(d.id)}
                >
                  <Clipboard className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>

              <div className="mt-4 flex items-start gap-3">
                <Switch
                  id={`auto-${d.id}`}
                  checked={d.mode === 'AUTO'}
                  disabled={modeMutation.isPending && modeMutation.variables?.id === d.id}
                  onCheckedChange={(on) =>
                    on ? setAutoTarget(d) : modeMutation.mutate({ id: d.id, mode: 'MANUAL' })
                  }
                />
                <div>
                  <Label htmlFor={`auto-${d.id}`} className="text-sm">
                    {t('devices.autoLabel', { defaultValue: 'Run without asking' })}
                  </Label>
                  <p className="text-micro text-muted-foreground">
                    {d.mode === 'AUTO'
                      ? t('devices.autoOn', {
                          defaultValue:
                            'Commands run as soon as the desktop app collects them. Nobody at the phone is asked first.',
                        })
                      : t('devices.autoOff', {
                          defaultValue:
                            'Every command waits for someone to approve it in the desktop app.',
                        })}
                  </p>
                  {/* THE SECOND GATE. Turning this switch on removes the
                      approval at the PHONE and nothing else: an agent's
                      command is still held by Jeeta's own write mode, which
                      lives one tab away. An owner who flips this and finds
                      the phone still idle has no way to guess that from
                      here — so it is said here. */}
                  <p className="mt-1 text-micro text-muted-foreground">
                    {t('devices.autoSecondGate', {
                      defaultValue:
                        'This switch only removes the approval at the phone. A command from Claude is also held by this workspace’s write mode — the Claude connector tab, next to this one, is where APPROVAL becomes AUTONOMOUS.',
                    })}
                  </p>
                </div>
              </div>

              <Probe deviceId={d.id} />

              <div className="mt-4 border-t border-border pt-2">
                <Disclosure title={t('devices.history', { defaultValue: 'Recent commands' })}>
                  <History deviceId={d.id} />
                </Disclosure>
              </div>
            </section>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('devices.add', { defaultValue: 'Add phone' })}</DialogTitle>
            <DialogDescription>
              {t('devices.addHint', {
                defaultValue:
                  'Give it a name you will recognise on the shelf. Adding it sends nothing to the phone.',
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="device-label">{t('devices.label', { defaultValue: 'Name' })}</Label>
              <Input
                id="device-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('devices.labelPlaceholder', { defaultValue: 'Office phone' })}
              />
            </div>
            <div>
              <Label htmlFor="device-serial">
                {t('devices.serial', { defaultValue: 'USB serial (optional)' })}
              </Label>
              <Input
                id="device-serial"
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder={t('devices.serialPlaceholder', {
                  defaultValue: 'Leave blank — the desktop app finds it',
                })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!label.trim() || createMutation.isPending}
            >
              {t('devices.add', { defaultValue: 'Add phone' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!autoTarget}
        onOpenChange={(open) => {
          if (!open) setAutoTarget(null);
        }}
        title={t('devices.autoTitle', { defaultValue: 'Let this phone act without asking?' })}
        description={t('devices.autoDesc', {
          defaultValue:
            'Commands will run the moment the desktop app collects them — including ones that open a chat or place a call. Nobody at the phone is asked first. You can turn this off at any time.',
        })}
        confirmLabel={t('devices.autoConfirm', { defaultValue: 'Turn on' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={modeMutation.isPending}
        onConfirm={() => autoTarget && modeMutation.mutate({ id: autoTarget.id, mode: 'AUTO' })}
      />

      <ConfirmDialog
        open={!!pauseTarget}
        onOpenChange={(open) => {
          if (!open) setPauseTarget(null);
        }}
        title={t('devices.pauseTitle', { defaultValue: 'Pause this phone?' })}
        description={t('devices.pauseDesc', {
          defaultValue:
            'Anything already waiting in the queue is dropped, not held. Pause is the stop button, not a hold.',
        })}
        confirmLabel={t('devices.pause', { defaultValue: 'Pause' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={statusMutation.isPending}
        onConfirm={() =>
          pauseTarget && statusMutation.mutate({ id: pauseTarget.id, status: 'PAUSED' })
        }
      />
    </div>
  );
}
