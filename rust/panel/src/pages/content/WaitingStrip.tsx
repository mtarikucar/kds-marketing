import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { UserRound } from 'lucide-react';
import { GENEL, type TreeOut, type WaitReason } from '@/api/content';
import { cn } from '@/components/ui';
import { placeHref } from './location';

type Kind = keyof TreeOut['waiting'];
const KINDS: { kind: Kind; reasons: WaitReason[]; tone: 'primary' | 'warning' | 'danger'; hash?: string }[] = [
  { kind: 'olay_confirmations', reasons: ['olay_proposed'], tone: 'primary' },
  { kind: 'shoot_requests', reasons: ['shoot_request', 'material_request'], tone: 'warning', hash: 'eksikler' },
  { kind: 'content_approvals', reasons: ['content_approval'], tone: 'warning' },
  { kind: 'content_times', reasons: ['content_time'], tone: 'primary' },
  { kind: 'problem_contents', reasons: ['content_problem'], tone: 'danger' },
];
const TONES = {
  primary: 'border-primary/20 bg-primary/10 text-primary',
  warning: 'border-warning/40 bg-warning-subtle text-warning',
  danger: 'border-danger/40 bg-danger-subtle text-danger',
};

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
  const chips = KINDS.filter(({ kind }) => (tree.waiting[kind] ?? 0) > 0);
  return (
    <section aria-label={t('content.waiting.title')} className={cn('flex flex-wrap items-center gap-2', className)}>
      <h2 className="me-1 flex items-center gap-1.5 text-sm font-medium">
        <UserRound aria-hidden="true" className="h-4 w-4 text-warning" />
        {t('content.waiting.title')}
      </h2>
      {chips.length === 0 && <p className="text-sm text-muted-foreground">{t('content.waiting.none')}</p>}
      {chips.map(({ kind, reasons, tone, hash }) => {
        const folder = folderFor(tree, reasons);
        const label = t(`content.waiting.${kind}`, { count: tree.waiting[kind] });
        const body = (
          <>
            <b className="font-mono font-medium">{tree.waiting[kind]}</b> {label}
          </>
        );
        const chip = cn('inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium', TONES[tone]);
        return folder ? (
          <Link key={kind} className={cn(chip, 'hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')} to={`${placeHref({ olay: folder })}${hash ? `#${hash}` : ''}`}>
            {body}
          </Link>
        ) : (
          <span key={kind} className={chip}>
            {body}
          </span>
        );
      })}
    </section>
  );
}
