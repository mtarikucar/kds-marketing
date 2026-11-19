import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info } from 'lucide-react';
import { addChannel } from '@/api/strategy';
import type { Stop } from '@/api/social';
import { POST_FORMATS, type PostFormat } from '@/api/posts';
import { kindLabel } from '@/lib/capabilities';
import { can } from '@/lib/roles';
import { useSession } from '@/auth/useSession';
import { Button, cn } from '@/components/ui';
import { ErrorCallout } from '@/components/ErrorCallout';
import { placeHref } from './location';

/** The kinds a post goes out on: the accounts whose stops the panel says. */
export const SOCIAL_KINDS = ['x', 'instagram', 'facebook_page', 'tiktok', 'linkedin_member', 'linkedin_page'] as const;

const isPostFormat = (f: string): f is PostFormat => (POST_FORMATS as readonly string[]).includes(f);

/** The sentence of `stop` on an account of `kind`. */
export function stopText(t: TFunction, kind: string, stop: Stop): string {
  const platform = kindLabel(t, kind);
  const format = stop.format && isPostFormat(stop.format) ? t(`posts.format.${stop.format}`) : (stop.format ?? '');
  switch (stop.code) {
    case 'media_missing':
      return stop.format === 'tiktok_video' ? t('stops.media_missing_video', { platform }) : t('stops.media_missing', { platform, format });
    case 'only_format':
      return t('stops.only_format_video', { platform });
    case 'lead':
      return t('stops.lead', { format, hours: stop.hours ?? 0 });
    case 'reconnect':
    case 'paused':
    case 'braked':
    case 'no_approved_strategy':
    case 'channel_not_in_strategy':
    case 'no_hypothesis':
    case 'posting_screen':
    case 'approval':
      return t(`stops.${stop.code}`, { platform });
  }
}

/** One action: prepares the strategy draft that adds the account's channel, then points to its approval. */
function PrepareStrategy({ kind }: { kind: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const prepare = useMutation({
    mutationFn: () => addChannel(kind),
    onSuccess: () => client.invalidateQueries({ queryKey: ['strategy'] }),
  });
  if (prepare.isSuccess) {
    return (
      <span role="status" className="text-success">
        {t('stops.act.prepared')}{' '}
        <Link className="underline" to="/strategy">{t('stops.act.toApprove')}</Link>
      </span>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" loading={prepare.isPending} onClick={() => prepare.mutate()}>{t('stops.act.prepare_strategy')}</Button>
      <ErrorCallout error={prepare.error} />
    </>
  );
}

/**
 * What stands between a request and a post on one account, as one compact list: each line says
 * what, then its one action, or what happens by itself. Read from the facts on every answer, so a
 * line goes the moment its cause does. `here` is the account's own header, where the pause switch
 * is already shown; `onAddMaterial` opens the upload where the content can take one.
 */
export function StopList({
  kind,
  capabilityId,
  stops,
  here = false,
  onAddMaterial,
  label,
}: {
  kind: string;
  capabilityId: string;
  stops: Stop[];
  here?: boolean;
  onAddMaterial?: () => void;
  label?: string;
}) {
  const { t } = useTranslation();
  // Preparing the draft is the consultation's (`team.manage`); anyone else is pointed to it.
  const strategy = can(useSession().data, 'team.manage');
  if (!stops.length) return null;
  const action = (stop: Stop) => {
    switch (stop.action) {
      case 'reconnect':
        return <Link className="text-primary underline" to="/connect">{t('stops.act.reconnect')}</Link>;
      case 'resume':
        return here
          ? <span className="text-muted-foreground">{t('stops.note.resumeHere')}</span>
          : <Link className="text-primary underline" to={placeHref({ account: capabilityId })}>{t('stops.act.resume')}</Link>;
      case 'approve_strategy':
        return <Link className="text-primary underline" to="/strategy">{t('stops.act.approve_strategy')}</Link>;
      case 'prepare_strategy':
        return strategy ? <PrepareStrategy kind={kind} /> : <Link className="text-primary underline" to="/strategy">{t('stops.act.approve_strategy')}</Link>;
      case 'add_material':
        return onAddMaterial
          ? <Button size="sm" variant="outline" onClick={onAddMaterial}>{t(stop.format === 'tiktok_video' ? 'stops.act.add_video' : 'stops.act.add_material')}</Button>
          : null;
      default:
        switch (stop.code) {
          case 'posting_screen':
          case 'approval':
            return <span className="text-muted-foreground">{t('stops.note.asked')}</span>;
          case 'lead':
            return <span className="text-muted-foreground">{t('stops.note.time')}</span>;
          case 'braked':
            return <span className="text-muted-foreground">{t('stops.note.braked')}</span>;
          default:
            return null;
        }
    }
  };
  return (
    <ul aria-label={label ?? t('stops.title')} className="divide-y divide-border rounded-md border border-border bg-surface text-sm">
      {stops.map((stop, i) => {
        const Icon = stop.blocking ? AlertTriangle : Info;
        const act = action(stop);
        return (
          <li key={`${stop.code}-${i}`} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 px-3 py-2">
            <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4', stop.blocking ? 'text-warning' : 'text-muted-foreground')} />
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 break-words">
                {stop.blocking && <span className="sr-only">{t('stops.blocking')}: </span>}
                {stopText(t, kind, stop)}
              </span>
              {act}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
