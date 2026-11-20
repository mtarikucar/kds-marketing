import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info } from 'lucide-react';
import type { Stop } from '@/api/social';
import { POST_FORMATS, type PostFormat } from '@/api/posts';
import { kindLabel } from '@/lib/capabilities';
import { Button, cn } from '@/components/ui';
import { placeHref } from '../posts/location';

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
    case 'knowledge_empty':
    case 'posting_screen':
    case 'approval':
      return t(`stops.${stop.code}`, { platform });
  }
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
  // A content with no video for TikTok already says TikTok takes only video: once is enough.
  const shown = stops.some((s) => s.code === 'media_missing') ? stops.filter((s) => s.code !== 'only_format') : stops;
  if (!shown.length) return null;
  const action = (stop: Stop) => {
    switch (stop.action) {
      case 'reconnect':
        return <Link className="text-primary underline" to="/connect">{t('stops.act.reconnect')}</Link>;
      case 'resume':
        return here
          ? <span className="text-muted-foreground">{t('stops.note.resumeHere')}</span>
          : <Link className="text-primary underline" to={placeHref({ accounts: true, account: capabilityId })}>{t('stops.act.resume')}</Link>;
      case 'open_knowledge':
        return <Link className="text-primary underline" to="/knowledge">{t('stops.act.open_knowledge')}</Link>;
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
      {shown.map((stop, i) => {
        // A missing video stops that content's post there, though the account itself can post.
        const warn = stop.blocking || stop.code === 'media_missing';
        const Icon = warn ? AlertTriangle : Info;
        const act = action(stop);
        return (
          <li key={`${stop.code}-${i}`} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2.5 px-3 py-2">
            <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4', warn ? 'text-warning' : 'text-muted-foreground')} />
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
