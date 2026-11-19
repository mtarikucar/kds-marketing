import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { Layers, LockKeyhole, Pause } from 'lucide-react';
import type { SocialAccount } from '@/api/social';
import { cn } from '@/components/ui';
import { areaTime } from '../content/AreaShared';
import { placeHref, type SocialPlace } from './location';

/** An account's kind and name, as every line of the page names it. */
export const accountLabel = (t: TFunction, a: Pick<SocialAccount, 'kind' | 'name'>) => `${a.name} · ${t(`capabilities.kinds.${a.kind}`)}`;

function Row({ to, current, icon, children, trailing, label }: { to: string; current: boolean; icon: ReactNode; children: ReactNode; trailing?: ReactNode; label?: string }) {
  return (
    <li>
      <Link
        to={to}
        aria-current={current ? 'page' : undefined}
        aria-label={label}
        className={cn(
          'flex min-h-11 w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          current ? 'bg-primary/10 text-primary' : 'text-foreground',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1">{children}</span>
        {trailing}
      </Link>
    </li>
  );
}

/**
 * The left rail, the content tree's counterpart: "Tüm hesaplar", then each connected account with
 * its kind, a mark when it is paused or its connection cannot be used, and its next post's time;
 * a dot where a post waits for a person.
 */
export function AccountRail({
  accounts,
  place,
  waits,
  top,
}: {
  accounts: SocialAccount[];
  place: SocialPlace;
  /** How many posts wait for a person, by account. */
  waits: Map<string, number>;
  /** Shown above the accounts (the phone's "Sizi bekleyenler"). */
  top?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const total = [...waits.values()].reduce((a, b) => a + b, 0);
  return (
    <nav aria-label={t('socialAccounts.accounts')} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-2">
      {top}
      <ul className="space-y-px">
        <Row to={placeHref({ view: 'all' })} current={!place.account} icon={<Layers aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
          trailing={<span className="font-mono text-xs text-muted-foreground">{accounts.length}</span>}>
          <span className="block font-medium">{t('socialAccounts.allAccounts')}</span>
          {total > 0 && <span className="block text-xs text-warning">{t('socialAccounts.waitingCount', { count: total })}</span>}
        </Row>
      </ul>
      <p className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('socialAccounts.accounts')}</p>
      <ul className="space-y-px">
        {accounts.map((a) => {
          const locked = a.status !== 'verified';
          const waiting = waits.get(a.capability_id) ?? 0;
          const states = [a.paused && t('socialAccounts.paused'), locked && t(`status.capability.${a.status}`, { defaultValue: t('socialAccounts.locked') })].filter(Boolean);
          return (
            <Row
              key={a.capability_id}
              to={placeHref({ account: a.capability_id })}
              current={place.account === a.capability_id}
              label={[accountLabel(t, a), ...states, waiting ? t('socialAccounts.waitingCount', { count: waiting }) : ''].filter(Boolean).join(' · ')}
              icon={a.paused ? <Pause aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> : locked ? <LockKeyhole aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-success" />}
              trailing={waiting > 0 ? <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warning" /> : undefined}
            >
              <span className="block truncate font-medium">{a.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {t(`capabilities.kinds.${a.kind}`)}
                {states.length > 0 && <> · {states.join(' · ')}</>}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {a.next ? t('socialAccounts.nextPost', { at: areaTime(a.next.publish_at, i18n.language) }) : t('socialAccounts.noNext')}
              </span>
            </Row>
          );
        })}
      </ul>
    </nav>
  );
}
