import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Clock } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Button,
} from '@/components/ui';

/**
 * The door for `GET`/`PATCH marketing/workspaces/timezone`.
 *
 * Those two routes shipped guarded, validated and audited — and with no caller
 * anywhere in the client, which made them a write surface that could not be
 * written. That matters more than the usual dead-code complaint, because of what
 * the column does. `Workspace.timezone` has carried a `'UTC'` default since the
 * first migration and, until this release, had exactly one writer in the whole
 * codebase (`agency.service.createLocation`), a path a self-serve customer never
 * touches. Five consumers read it as though it meant something: the dashboard
 * aggregates, the tasks list, sales targets, the daily digest, and now the
 * Growth Studio's Today rail. A Turkey workspace's "today" therefore ran
 * 03:00→03:00 Istanbul and quietly dropped its own early-morning rows.
 *
 * Registration now captures the browser's zone, which fixes every NEW workspace.
 * This is the other half and the only half that reaches the workspaces that
 * ALREADY EXIST: their stored 'UTC' is indistinguishable from a deliberate
 * choice, so nothing but a person saying so can correct it.
 *
 * Lives on Brand → Business rather than in a settings page of its own because
 * `/branding` is already MANAGER-gated in App.tsx, which is exactly the floor
 * the PATCH enforces (MANAGER + `settings.manage`) — the affordance and the
 * endpoint agree without a second gate to keep in step.
 */

/** Same curated fallback as BookingSettingsPage; the backend takes any IANA zone. */
const FALLBACK_ZONES = [
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Tashkent',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Every zone the runtime knows, plus the two that must be selectable whether it
 * knows them or not: what this workspace is stored as, and what this browser
 * reports.
 *
 * `Intl.supportedValuesOf('timeZone')` returns the CANONICAL set and leaves out
 * the link names browsers and operating systems still hand out — 'Asia/Calcutta',
 * 'US/Eastern', 'Europe/Kiev'. Registration writes whatever the browser said, so
 * a stored value can legitimately be one of those; dropping it from the list
 * would show a manager an empty picker over a perfectly valid setting, and the
 * first thing they did would be to change it.
 */
function zoneOptions(current: string | null): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  if (all.length === 0) all = FALLBACK_ZONES;
  const set = new Set(all);
  if (current) set.add(current);
  const browser = browserZone();
  if (browser) set.add(browser);
  set.add('UTC');
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function WorkspaceTimezoneCard() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ timezone: string }>({
    queryKey: ['marketing', 'workspace', 'timezone'],
    queryFn: () => marketingApi.get('/workspaces/timezone').then((r) => r.data),
  });

  const stored = data?.timezone ?? null;
  const [value, setValue] = useState('');
  // The stored zone is the initial selection, and re-syncing on every arrival is
  // deliberate: a save invalidates this query, so the picker follows what the
  // server actually accepted rather than what was clicked.
  useEffect(() => {
    if (stored) setValue(stored);
  }, [stored]);

  const options = useMemo(() => zoneOptions(stored), [stored]);
  const browser = browserZone();

  const save = useMutation({
    mutationFn: (timezone: string) =>
      marketingApi.patch('/workspaces/timezone', { timezone }).then((r) => r.data),
    onSuccess: () => {
      // Both the dedicated read AND the profile: `useWorkspaceProfile` carries
      // `timezone` too, and it is the copy the Growth Studio's Today rail reads.
      // Refreshing only this card would leave the rail drawing yesterday's
      // boundaries until the profile's 5-minute staleTime expired.
      qc.invalidateQueries({ queryKey: ['marketing', 'workspace', 'timezone'] });
      qc.invalidateQueries({ queryKey: ['marketing', 'workspace', 'profile'] });
      toast.success(t('workspace.tz.saved', 'Çalışma alanı saat dilimi güncellendi'));
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? t('workspace.tz.saveFailed', 'Saat dilimi kaydedilemedi'),
      ),
  });

  const dirty = !!value && !!stored && value !== stored;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4" aria-hidden="true" />
          {t('workspace.tz.title', 'Saat dilimi')}
        </CardTitle>
        <CardDescription>
          {t(
            'workspace.tz.desc',
            'Raporlardaki ve listelerdeki "bugün" bu saat diliminde başlar. İşletmenin saatini seç — tarayıcının değil.',
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <Field label={t('workspace.tz.label', 'Çalışma alanı saat dilimi')}>
          {({ id }) => (
            <select
              id={id}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              value={value}
              disabled={isLoading}
              onChange={(e) => setValue(e.target.value)}
            >
              {options.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          )}
        </Field>

        {/*
          Named, not silently defaulted. A workspace still reading 'UTC' is the
          exact case this control exists for — the value is indistinguishable
          from a deliberate choice, so the only honest thing is to say what it
          is and what this browser thinks, and let a person decide.
        */}
        {browser && stored && browser !== stored && (
          <p className="text-xs text-muted-foreground" data-testid="tz-browser-hint">
            {t('workspace.tz.browserHint', 'Bu tarayıcı {{zone}} diliminde — kayıtlı değer {{stored}}.', {
              zone: browser,
              stored,
            })}{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setValue(browser)}
            >
              {t('workspace.tz.useBrowser', 'Tarayıcınınkini kullan')}
            </button>
          </p>
        )}
      </CardContent>

      <CardFooter className="justify-end border-t border-border pt-4">
        <Button
          type="button"
          disabled={!dirty || save.isPending}
          loading={save.isPending}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
        </Button>
      </CardFooter>
    </Card>
  );
}

export default WorkspaceTimezoneCard;
