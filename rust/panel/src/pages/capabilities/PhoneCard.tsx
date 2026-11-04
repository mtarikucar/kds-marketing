import { useEffect, useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Smartphone } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { getCommand, isFinal, phoneCommands, type CommandStatus, type LoggedCommand } from '@/api/devices';
import type { Capability, CapabilityOut, Permission } from '@/api/types';
import { CopyField } from '@/components/CopyField';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  toast,
  type BadgeProps,
} from '@/components/ui';
import { browser, fileUrl } from '@/lib/browser';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useCreateKey } from '@/pages/ApiKeysPage';
import { PHONE_REFRESH_MS, deviceCommandKey, invalidateCapabilities, phoneLogKey } from './queries';

/** The feature a bridge lists for a phone that types text outside ASCII (`jt_devices`). */
const TEXT_UNICODE = 'text.unicode';
/** How many of a phone's most recent commands its card shows. */
const LOG_LIMIT = 20;
/** How often an open command that has not ended is read again. */
const COMMAND_POLL_MS = 3_000;
/** The one permission a device bridge's key holds: any other makes every bridge route refuse it. */
const BRIDGE_SCOPE: Permission = 'devices.bridge';
/** Where the bridge's setup, its logon task and its troubleshooting are written down. */
const OPS_DOC = 'docs/operations/device-bridge.md';

/**
 * What a phone's bridge reported of it when it last registered it (`connector_public.device`):
 * the phone's facts, the bridge program's, and whether that bridge's latest registration lists
 * the phone (`listed`).
 */
export interface PhoneFacts {
  platform: string;
  model: string;
  os_version: string;
  /** The computer the bridge runs on (its configured `bridge_id`, else the computer's name). */
  bridge_id: string;
  /** The bridge program's version. */
  version: string;
  /** The command kinds its bridge runs on it, and `text.unicode`. */
  features: string[];
  listed: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The facts a `phone` capability carries, or `null` before a bridge first registered it. */
export function phoneFactsOf(capability: Capability): PhoneFacts | null {
  const raw = (capability.connector_public as Record<string, unknown>).device;
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  return {
    platform: text(d.platform),
    model: text(d.model),
    os_version: text(d.os_version),
    bridge_id: text(d.bridge_id),
    version: text(d.version),
    features: Array.isArray(d.features) ? d.features.filter((f): f is string => typeof f === 'string') : [],
    listed: d.listed === true,
  };
}

/**
 * Whether a command's result names a file (`jt_app::usecases::devices::agent::named_file`): a
 * pulled file, or an observation's screenshot.
 */
function namesFile(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false;
  if (result.kind === 'file') return typeof result.file_id === 'string';
  return result.kind === 'observation' && typeof result.screenshot_file_id === 'string';
}

type Tone = NonNullable<BadgeProps['tone']>;

const STATUS_TONE: Record<CommandStatus, Tone> = {
  queued: 'info',
  leased: 'primary',
  done: 'success',
  failed: 'danger',
  expired: 'warning',
  canceled: 'neutral',
};

/**
 * A phone on its capability card: what its bridge reported of it (platform, model, OS version,
 * the computer and the bridge's version, whether it types Unicode text, the commands it runs),
 * whether it takes a command now and how long ago its bridge last listed it, and, for who holds
 * `devices.work` (`canWork`), its last commands. It takes a command when it reads verified and
 * its bridge's latest registration lists it, as `devices.act` checks; only those registrations
 * verify it. While `live` (the Devices tab is shown) its log is read again every heartbeat; the
 * page reads the phones themselves as often. How long ago its bridge listed it is told as of
 * `readAt`, when the phones were last read, so a silent phone's age moves on with each read. The
 * setup is in `docs/operations/device-bridge.md`.
 */
export function PhoneCard({
  item,
  canWork,
  live,
  readAt,
}: {
  item: CapabilityOut;
  canWork: boolean;
  live: boolean;
  /** When `item` was read (the list query's `dataUpdatedAt`); now when unknown. */
  readAt?: number;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const c = item.capability;
  const facts = phoneFactsOf(c);
  const unicode = facts?.features.includes(TEXT_UNICODE) ?? false;

  // The card's status in a few words, beside how long ago its bridge last listed it: neutral
  // past "online", since a phone can also be marked unreachable by hand.
  const state = (f: PhoneFacts): string => {
    switch (item.effective_status) {
      case 'verified':
        return t(f.listed ? 'capabilities.phone.states.online' : 'capabilities.phone.states.unlisted');
      case 'stale':
        return t('capabilities.phone.states.stale');
      default:
        return t(`status.capability.${item.effective_status}`);
    }
  };
  const platform = (p: string) =>
    p === 'android' || p === 'ios' ? t(`capabilities.phone.platforms.${p}`) : p;
  const rows: [string, string][] = facts
    ? [
        [
          t('capabilities.phone.status'),
          c.last_verified_at
            ? `${state(facts)} · ${t('capabilities.phone.seen', {
                ago: formatRelative(c.last_verified_at, i18n.language, readAt ? new Date(readAt) : undefined),
              })}`
            : state(facts),
        ],
        [t('capabilities.phone.platform'), platform(facts.platform)],
        [t('capabilities.phone.model'), facts.model],
        [t('capabilities.phone.os'), facts.os_version],
        [t('capabilities.phone.computer'), facts.bridge_id],
        [t('capabilities.phone.version'), facts.version],
        [t('capabilities.phone.unicode'), unicode ? t('capabilities.phone.yes') : t('capabilities.phone.no')],
      ]
    : [];
  const kinds = facts?.features.filter((f) => f !== TEXT_UNICODE) ?? [];

  return (
    <div role="group" aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p id={`${id}-title`} className="text-caption text-muted-foreground">
        {t('capabilities.phone.title')}
      </p>
      {facts ? (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-caption text-muted-foreground">{label}</dt>
                <dd className="break-words text-foreground">{value || '—'}</dd>
              </div>
            ))}
            <div className="flex flex-col gap-0.5 sm:col-span-2">
              <dt className="text-caption text-muted-foreground">{t('capabilities.phone.commands')}</dt>
              <dd className="break-words font-mono text-caption text-foreground">{kinds.join(', ') || '—'}</dd>
            </div>
          </dl>
          {!unicode && (
            // The bridge lists `text.unicode` only once ADBKeyBoard is installed and enabled.
            <p data-unicode-hint="" className="text-caption text-foreground">
              <Trans i18nKey="capabilities.phone.unicodeHint" components={{ b: <strong /> }} />
            </p>
          )}
          {canWork && <CommandLog capabilityId={c.id} live={live} />}
        </>
      ) : (
        <p className="text-sm text-foreground">{t('capabilities.phone.never')}</p>
      )}
      <p className="text-caption text-muted-foreground">
        {t('capabilities.phone.hint')} <code className="font-mono text-micro">{OPS_DOC}</code>
      </p>
    </div>
  );
}

/**
 * A phone's last {@link LOG_LIMIT} commands, newest first: kind, status and when it was queued;
 * each opens to its arguments and, read then, its result. Read again every heartbeat while
 * `live`. The arguments carry what was typed and the shell's arguments: shown here, never logged,
 * and dropped from the cache as soon as the log is gone.
 */
function CommandLog({ capabilityId, live }: { capabilityId: string; live: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const log = useQuery({
    queryKey: phoneLogKey(capabilityId),
    queryFn: () => phoneCommands(capabilityId, { limit: LOG_LIMIT }),
    gcTime: 0,
    refetchInterval: live ? PHONE_REFRESH_MS : false,
  });
  const commands = log.data ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <p id={`${id}-log`} className="text-caption text-muted-foreground">
        {t('capabilities.phone.log.title')}
      </p>
      <QueryState query={log} keepOnError>
        {commands.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('capabilities.phone.log.empty')}</p>
        ) : (
          <ul aria-labelledby={`${id}-log`} className="flex flex-col divide-y divide-border rounded-md border border-border">
            {commands.map((command) => (
              <CommandRow key={command.command_id} command={command} />
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

function CommandRow({ command }: { command: LoggedCommand }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        // Only an open row has a region to point at.
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 px-2 py-1.5 text-start text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <code className="font-mono text-caption text-foreground">{command.kind}</code>
        <Badge size="sm" tone={STATUS_TONE[command.status]}>
          {t(`capabilities.phone.log.statuses.${command.status}`)}
        </Badge>
        <span className="ms-auto text-caption text-muted-foreground">
          {formatDateTime(command.created_at, i18n.language)}
        </span>
      </button>
      {/* Mounted only while open, so a folded command reads nothing. */}
      {open && <CommandDetails id={detailsId} command={command} />}
    </li>
  );
}

const PRE = 'max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-2 font-mono text-micro text-foreground';

/**
 * A command's arguments, why it failed, and its result, read at once (no wait for it to end) and
 * again every few seconds until it has ended; once that read says another status than the log's
 * row, the phone's log is read again, so the row's badge says the same. Its file opens at an
 * address signed on the click: one read with the command lives ten minutes.
 */
function CommandDetails({ id, command }: { id: string; command: LoggedCommand }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const full = useQuery({
    queryKey: deviceCommandKey(command.command_id),
    queryFn: () => getCommand(command.command_id, { wait_s: 0 }),
    gcTime: 0,
    refetchInterval: (query) => (isFinal(query.state.data?.status ?? command.status) ? false : COMMAND_POLL_MS),
  });
  const current = full.data ?? command;
  const seen = full.data?.status;
  useEffect(() => {
    if (seen && seen !== command.status) {
      void queryClient.invalidateQueries({ queryKey: phoneLogKey(command.capability_id) });
    }
  }, [seen, command.status, command.capability_id, queryClient]);
  const args = Object.fromEntries(Object.entries(command.command).filter(([key]) => key !== 'kind'));

  const openFile = async () => {
    // Opened on the click itself, which a browser lets open a tab; sent on once the address is in.
    const tab = browser.openPending();
    const fresh = await full.refetch();
    // A read that failed still holds the data of the one before: its address may have expired.
    if (fresh.isError) {
      tab?.close();
      toast.error(errorMessage(t, fresh.error));
      return;
    }
    const url = fresh.data?.file_url ? fileUrl(fresh.data.file_url) : null;
    if (tab && url) {
      tab.go(url);
      return;
    }
    tab?.close();
    toast.error(t(url ? 'capabilities.phone.log.fileBlocked' : 'capabilities.phone.log.fileGone'));
  };

  return (
    <div id={id} className="flex flex-col gap-2 px-2 pb-2">
      {current.reason && (
        <p className="text-caption text-danger">
          {t('capabilities.phone.log.reason', { reason: t(`capabilities.phone.log.reasons.${current.reason}`) })}
          {current.detail && <> — {current.detail}</>}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-caption text-muted-foreground">{t('capabilities.phone.log.args')}</p>
        <pre className={PRE}>{Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : '—'}</pre>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-caption text-muted-foreground">{t('capabilities.phone.log.result')}</p>
        <QueryState query={full} keepOnError>
          {full.data?.result ? (
            <pre className={PRE}>{JSON.stringify(full.data.result, null, 2)}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">{t('capabilities.phone.log.noResult')}</p>
          )}
          {namesFile(full.data?.result) && (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => void openFile()}>
                {t('capabilities.phone.log.file')}
              </Button>
            </div>
          )}
        </QueryState>
      </div>
    </div>
  );
}

/**
 * "Pair a bridge" on the Devices tab: before a phone exists, this is how one comes. Offered to
 * who holds `api_keys.manage` and `devices.bridge`, all a bridge key needs (a key's scopes must
 * be among its issuer's own).
 */
export function PairBridgePanel() {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-1">
        <p id={`${id}-title`} className="font-medium text-foreground">
          {t('capabilities.phone.pair.title')}
        </p>
        <p className="text-sm text-muted-foreground">{t('capabilities.phone.pair.body')}</p>
      </div>
      <Button className="shrink-0" onClick={() => setOpen(true)}>
        <Smartphone className="h-4 w-4" aria-hidden="true" />
        {t('capabilities.phone.pair.open')}
      </Button>
      <PairBridgeDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}

/**
 * Issues a device bridge's key, with exactly `devices.bridge`, and shows it once with the three
 * steps to run the bridge ({@link useCreateKey}, as the API keys page does: the plaintext is held
 * only in the dialog's state and dropped when it closes; while it is shown only the Close button
 * closes the dialog). Closing it once a key was issued reads the phones again: the bridge may be
 * running by then.
 */
function PairBridgeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => t('capabilities.phone.pair.defaultName'));
  const { created, creating, error, create, reset } = useCreateKey();

  const close = (next: boolean) => {
    if (!next) {
      if (created) void invalidateCapabilities(queryClient);
      setName(t('capabilities.phone.pair.defaultName'));
      reset();
    }
    onOpenChange(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Never an empty list: a key issued without scopes holds every permission of its issuer.
    void create({ name: name.trim(), scopes: [BRIDGE_SCOPE] });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent dismissible={created == null}>
        <DialogHeader>
          <DialogTitle>{created ? t('apiKeys.dialog.plaintextTitle') : t('capabilities.phone.pair.dialogTitle')}</DialogTitle>
          <DialogDescription>
            {created ? t('capabilities.phone.pair.keyDescription') : t('capabilities.phone.pair.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning" title={t('apiKeys.dialog.plaintextTitle')}>
              {t('apiKeys.dialog.plaintextWarning')}
            </Callout>
            <CopyField label={t('apiKeys.dialog.plaintextTitle')} value={created.plaintext} />
            <InstallSteps plaintext={created.plaintext} />
            <Callout tone="info">{t('capabilities.phone.pair.ownKey')}</Callout>
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('common.close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <ErrorCallout error={error} />
            <Field label={t('fields.name')} hint={t('capabilities.phone.pair.nameHint')} required>
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  required
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={creating}>
                {t('apiKeys.dialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The three steps on the computer the phone is plugged into, the configuration file ready with
 * this server's address and the new key (`jeeta-device-bridge.toml` beside the program, which
 * reads it there by default).
 */
function InstallSteps({ plaintext }: { plaintext: string }) {
  const { t } = useTranslation();
  // The panel and its API share one origin; the bridge appends `api/devices/bridge/…` to it.
  const config = `base_url = "${window.location.origin}"\nkey = "${plaintext}"\n`;
  return (
    <ol aria-label={t('capabilities.phone.pair.stepsLabel')} className="flex list-decimal flex-col gap-3 ps-5 text-sm">
      <li>{t('capabilities.phone.pair.step1')}</li>
      <li>
        <div className="flex flex-col gap-2">
          <span>{t('capabilities.phone.pair.step2')}</span>
          <CopyField multiline label={t('capabilities.phone.pair.configLabel')} value={config} />
          <span className="text-caption text-muted-foreground">{t('capabilities.phone.pair.keyEnv')}</span>
        </div>
      </li>
      <li>
        {t('capabilities.phone.pair.step3')} <code className="font-mono text-micro">{OPS_DOC}</code>
      </li>
    </ol>
  );
}
