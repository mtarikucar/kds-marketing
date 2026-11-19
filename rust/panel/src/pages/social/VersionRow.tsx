import { useRef, useState } from 'react';
import { useMutation, useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { isApiError } from '@/api/client';
import * as api from '@/api/social';
import { materialGet } from '@/api/materials';
import type { PostOut, PostsOut } from '@/api/posts';
import { BLOCKED_REASONS } from '@/api/content';
import { Badge, Button, cn } from '@/components/ui';
import { areaTime, MiniThumb } from '../content/AreaShared';
import { PlatformFrame } from '../content/PlatformFrame';
import { useMaterialsKey } from '../materials/MaterialsShared';
import { inputClass } from '../StudioShared';
import { usePostMutation } from './PostRow';
import { placeHref } from './location';
import { suggestTimes, type TimelineVersion } from './timeline';

/** The posting engine's refusal codes a person can read; any other shows as the server says it. */
const REFUSALS = [
  'lead_too_short', 'beyond_horizon', 'quiet_hours', 'cap_per_day', 'spacing', 'format_unsupported', 'media_count', 'media_type',
  'version_already_scheduled', 'area_redo_open', 'version_made_for_another_account', 'account_paused',
] as const;

/** Why the server refused a time: the first refused post's reason, in words when it is known. */
export function refusalText(t: TFunction, error: unknown): string {
  if (!isApiError(error)) return String(error);
  const items = error.details.items;
  const first = Array.isArray(items) ? (items[0] as { reason?: unknown } | undefined)?.reason : undefined;
  const code = String(first ?? error.details.reason ?? error.message);
  const known = REFUSALS.find((r) => r === code);
  return known ? t(`socialAccounts.refusal.${known}`) : code;
}

/** Where a blocked version is fixed: the strategy, the connections, or the paused account. */
type FixLabel = 'socialAccounts.fixStrategy' | 'socialAccounts.connect' | 'socialAccounts.fixPaused';
function fixOf(reason: string | undefined, accounts: api.SocialAccount[]): { to: string; label: FixLabel } | null {
  switch (reason) {
    case 'no_approved_strategy':
    case 'channel_not_in_strategy':
    case 'hypothesis_does_not_post':
      return { to: '/strategy', label: 'socialAccounts.fixStrategy' };
    case 'no_connected_account':
    case 'its_account_unavailable':
    case 'format_not_supported':
      return { to: '/connect', label: 'socialAccounts.connect' };
    case 'account_paused': {
      const paused = accounts.find((a) => a.paused);
      return paused ? { to: placeHref({ account: paused.capability_id }), label: 'socialAccounts.fixPaused' } : null;
    }
    default:
      return null;
  }
}

/**
 * The compact way to give a waiting version its time now, instead of waiting for the agent: the
 * account (as text when only one can take it), a few one-tap times derived from the account's
 * own posts, and one field for another time. The engine checks every time as it checks the
 * agent's and says why it refuses one.
 */
function ScheduleControl({ item, accounts, posts, details }: { item: TimelineVersion; accounts: api.SocialAccount[]; posts?: PostsOut; details: Map<string, api.AccountDetail> }) {
  const { t, i18n } = useTranslation();
  const refresh = usePostMutation();
  const { pack, version } = item;
  const [account, setAccount] = useState(version.accounts[0]);
  const [at, setAt] = useState('');
  // One key per attempt: a retry of the same choice replays, a new choice is a new request.
  const requestKey = useRef<{ choice: string; key: string } | null>(null);
  const schedule = useMutation({
    mutationFn: (publishAt: string) => {
      const choice = `${account}|${publishAt}`;
      if (requestKey.current?.choice !== choice) requestKey.current = { choice, key: crypto.randomUUID() };
      return api.versionSchedule({ project_id: pack.project_id, version_id: version.version_id, capability_id: account, publish_at: publishAt, request_key: requestKey.current.key });
    },
    onSuccess: async () => {
      requestKey.current = null;
      await refresh();
    },
  });
  const name = (id: string) => accounts.find((a) => a.capability_id === id)?.name ?? t('socialAccounts.unknownAccount');
  const settings = posts?.settings;
  const suggestions = settings
    ? suggestTimes({ format: version.format as PostOut['post']['format'], capabilityId: account, settings, posts: posts.posts, published: details.get(account)?.recent ?? [] })
    : [];
  if (schedule.isSuccess) return <p role="status" className="text-sm text-success">{t('socialAccounts.scheduled')}</p>;
  return (
    <div className="min-w-0 basis-full space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {version.accounts.length === 1 ? (
          <span className="font-medium">{t('socialAccounts.onAccount', { account: name(account) })}</span>
        ) : (
          <label className="flex items-center gap-2">
            <span>{t('socialAccounts.scheduleAccount')}</span>
            <select className={cn(inputClass, 'w-auto py-1.5')} value={account} onChange={(e) => { setAccount(e.target.value); schedule.reset(); }}>
              {version.accounts.map((id) => <option key={id} value={id}>{name(id)}</option>)}
            </select>
          </label>
        )}
        {suggestions.map((s) => (
          <Button key={s} size="sm" variant="outline" disabled={schedule.isPending} aria-label={t('socialAccounts.scheduleAtSuggestion', { at: areaTime(s, i18n.language) })} onClick={() => schedule.mutate(s)}>
            <CalendarClock aria-hidden="true" className="h-4 w-4" />
            {new Date(s).toLocaleString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </Button>
        ))}
      </div>
      {suggestions.length > 0 && <p className="text-xs text-muted-foreground">{t('socialAccounts.suggestionsHelp')}</p>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (at && !schedule.isPending) schedule.mutate(new Date(at).toISOString()); }}>
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span>{t(suggestions.length ? 'socialAccounts.otherTime' : 'socialAccounts.scheduleAt')}</span>
          <input type="datetime-local" className={cn(inputClass, 'py-1.5')} value={at} onChange={(e) => { setAt(e.target.value); schedule.reset(); }} required />
        </label>
        <Button size="sm" type="submit" disabled={!at} loading={schedule.isPending}>{t('socialAccounts.schedule')}</Button>
      </form>
      {schedule.error != null && <p role="alert" className="text-sm text-danger">{t('socialAccounts.scheduleRefused', { reason: refusalText(t, schedule.error) })}</p>}
    </div>
  );
}

/** A version's whole text, its package's note and the preview, opened. */
function VersionDetail({ item, files, account }: { item: TimelineVersion; files: boolean; account: string }) {
  const { t, i18n } = useTranslation();
  const key = useMaterialsKey();
  const { pack, version } = item;
  const materials = useQueries({ queries: version.material_ids.map((id) => ({ queryKey: [...key, 'material', id], queryFn: () => materialGet(id), enabled: files, staleTime: 60_000, retry: false })) });
  return (
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="min-w-0 space-y-3 text-sm">
        <p className="whitespace-pre-wrap break-words">{version.text}</p>
        {version.material_ids.length > 0 && (
          <div className="flex flex-wrap gap-1.5">{version.material_ids.map((id) => <MiniThumb key={id} id={id} size="h-14 w-14" files={files} link={false} />)}</div>
        )}
        <section className="space-y-1 border-t border-border pt-3">
          <h4 className="font-medium">{pack.goal}</h4>
          <p className="whitespace-pre-wrap text-muted-foreground">{pack.summary}</p>
          <p className="text-xs text-muted-foreground">{t('socialAccounts.delivered', { at: areaTime(pack.delivered_at, i18n.language) })}</p>
        </section>
      </div>
      <PlatformFrame version={{ format: version.format as never, text: version.text, tags: [], material_ids: version.material_ids }} materials={materials.flatMap((m) => (m.data ? [m.data.material] : []))} account={account} />
    </div>
  );
}

/**
 * A finished content's version with no time yet, as a row of "Sizi bekleyenler": the agent gives
 * it a time on its next run; a person who does not want to wait gives it here. One no account
 * can take says why and where that is fixed.
 */
export function VersionRow({
  item,
  accounts,
  posts,
  details,
  expanded,
  onToggle,
  files,
}: {
  item: TimelineVersion;
  accounts: api.SocialAccount[];
  posts?: PostsOut;
  details: Map<string, api.AccountDetail>;
  expanded: boolean;
  onToggle: () => void;
  files: boolean;
}) {
  const { t } = useTranslation();
  const { pack, version } = item;
  // The time control opens on request, or at once for the version an address names.
  const [giving, setGiving] = useState(expanded);
  const blocked = version.accounts.length === 0;
  const reason = BLOCKED_REASONS.find((r) => r === version.blocked);
  const fix = blocked ? fixOf(version.blocked, accounts) : null;
  const panel = `version-${version.version_id}-detail`;
  const opening = version.text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const name = accounts.find((a) => a.capability_id === version.accounts[0])?.name ?? t('socialAccounts.unknownAccount');
  return (
    <article id={`version-${version.version_id}`} aria-label={opening || pack.goal} className={cn('min-w-0 scroll-mt-4 rounded-lg border bg-surface shadow-xs', blocked ? 'border-danger/50' : 'border-primary/30')}>
      <button type="button" aria-expanded={expanded} aria-controls={panel} onClick={onToggle}
        className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-3 rounded-t-lg px-3 pb-2 pt-3 text-start hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[2.75rem_minmax(0,1fr)_auto_1.25rem] sm:px-4">
        {version.material_ids[0] ? <MiniThumb id={version.material_ids[0]} size="h-11 w-11" files={files} link={false} /> : <span className="flex h-11 w-11 items-center justify-center rounded bg-surface-muted"><ImageIcon aria-hidden="true" className="h-5 w-5 text-muted-foreground" /></span>}
        <span className="min-w-0">
          <span className="block truncate font-medium">{opening || pack.goal}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{t(`posts.format.${version.format}`, { defaultValue: version.format })}</span>
            <span className="min-w-0 truncate">{pack.goal}</span>
          </span>
        </span>
        <Badge tone={blocked ? 'danger' : 'primary'} className="max-sm:col-start-2 max-sm:justify-self-start">
          {blocked ? <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <CalendarClock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
          {t(blocked ? 'socialAccounts.state.blocked' : 'socialAccounts.state.time')}
        </Badge>
        <ChevronDown aria-hidden="true" className={cn('hidden h-5 w-5 text-muted-foreground transition-transform sm:block', expanded && 'rotate-180')} />
      </button>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-3 sm:ps-[4.75rem]">
        {blocked ? (
          <>
            <p className="basis-full text-sm text-danger">{reason ? t(`socialAccounts.blocked.${reason}`) : t('socialAccounts.noSuitableAccount')}</p>
            {fix && <Button size="sm" variant="outline" asChild><Link to={fix.to}>{t(fix.label)}</Link></Button>}
          </>
        ) : (
          <>
            <p className="min-w-0 flex-[1_1_16rem] text-sm text-muted-foreground">{t('socialAccounts.agentGivesTime')}</p>
            {giving
              ? <ScheduleControl item={item} accounts={accounts} posts={posts} details={details} />
              : <Button size="sm" variant="outline" onClick={() => setGiving(true)}><CalendarClock aria-hidden="true" className="h-4 w-4" />{t('content.bar.giveTime')}</Button>}
          </>
        )}
      </div>
      {expanded && (
        <div id={panel} className="border-t border-border bg-surface-muted/40 px-3 py-4 sm:px-4">
          <VersionDetail item={item} files={files} account={blocked ? t('socialAccounts.unknownAccount') : name} />
        </div>
      )}
    </article>
  );
}
