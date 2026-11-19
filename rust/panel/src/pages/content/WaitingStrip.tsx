import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { UserRound } from 'lucide-react';
import { GENEL, type TreeOut, type WaitReason } from '@/api/content';
import { cn } from '@/components/ui';
import { placeHref } from './location';

type Kind = keyof TreeOut['waiting'];
const KINDS: { kind: Kind; reasons: WaitReason[]; tone: WaitTone; hash?: string }[] = [
  { kind: 'olay_confirmations', reasons: ['olay_proposed'], tone: 'primary' },
  { kind: 'shoot_requests', reasons: ['shoot_request', 'material_request'], tone: 'warning', hash: 'eksikler' },
  { kind: 'content_approvals', reasons: ['content_approval'], tone: 'warning' },
  { kind: 'content_times', reasons: ['content_time'], tone: 'primary' },
  { kind: 'problem_contents', reasons: ['content_problem'], tone: 'danger' },
];
export type WaitTone = 'primary' | 'warning' | 'danger';
const TONES: Record<WaitTone, string> = {
  primary: 'border-primary/20 bg-primary/10 text-primary',
  warning: 'border-warning/40 bg-warning-subtle text-warning',
  danger: 'border-danger/40 bg-danger-subtle text-danger',
};

/** One counted chip of "Sizi bekleyenler": a link, a filter button (`pressed`), or plain. */
export interface WaitChip {
  key: string;
  count: number;
  label: string;
  tone: WaitTone;
  to?: string;
  onClick?: () => void;
  pressed?: boolean;
}

/**
 * "Sizi bekleyenler" as a strip: its title, then a counted chip per kind that waits, or a few
 * words when nothing does (none with `quiet`, when the caller says it below); `children`, the
 * waiting rows themselves, follow the title line. The content page's and the social page's.
 */
export function WaitingChips({ chips, className, quiet, children }: { chips: WaitChip[]; className?: string; quiet?: boolean; children?: ReactNode }) {
  const { t } = useTranslation();
  const shown = chips.filter((c) => c.count > 0);
  return (
    <section aria-label={t('content.waiting.title')} className={cn('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="me-1 flex items-center gap-1.5 text-sm font-medium">
          <UserRound aria-hidden="true" className="h-4 w-4 text-warning" />
          {t('content.waiting.title')}
        </h2>
        {shown.length === 0 && !quiet && <p className="text-sm text-muted-foreground">{t('content.waiting.none')}</p>}
        {shown.map(({ key, count, label, tone, to, onClick, pressed }) => {
          const body = (
            <>
              <b className="font-mono font-medium">{count}</b> {label}
            </>
          );
          const chip = cn('inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium', TONES[tone]);
          const active = 'hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
          if (to) return <Link key={key} className={cn(chip, active)} to={to}>{body}</Link>;
          if (onClick) return <button key={key} type="button" aria-pressed={!!pressed} onClick={onClick} className={cn(chip, active, pressed && 'ring-2 ring-current ring-offset-1 ring-offset-background')}>{body}</button>;
          return <span key={key} className={chip}>{body}</span>;
        })}
      </div>
      {children}
    </section>
  );
}

/** The first folder that waits for `reasons`: an olay of the tree, else Genel. */
function folderFor(tree: TreeOut, reasons: WaitReason[]): string | null {
  const olay = tree.olays.find((o) => o.waits.some((w) => reasons.includes(w)));
  if (olay) return olay.olay.id;
  return tree.genel.waits.some((w) => reasons.includes(w)) ? GENEL : null;
}

/**
 * "Sizi bekleyenler": only the exceptions, each leading to the first folder where it waits (an
 * olay to confirm, a capture asked for, an approval, a finished content with no time yet, a stuck
 * content). Nothing when nothing waits.
 */
export function WaitingStrip({ tree, className }: { tree: TreeOut; className?: string }) {
  const { t } = useTranslation();
  const chips = KINDS.map(({ kind, reasons, tone, hash }): WaitChip => {
    const folder = folderFor(tree, reasons);
    return {
      key: kind,
      count: tree.waiting[kind] ?? 0,
      label: t(`content.waiting.${kind}`, { count: tree.waiting[kind] }),
      tone,
      to: folder ? `${placeHref({ olay: folder })}${hash ? `#${hash}` : ''}` : undefined,
    };
  });
  return <WaitingChips chips={chips} className={className} />;
}
