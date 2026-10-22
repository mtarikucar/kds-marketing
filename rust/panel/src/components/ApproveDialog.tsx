import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isApiError } from '@/api/client';
import { approveDraft } from '@/api/strategy';
import { SECTION_KEYS, type ApproveStamp, type SectionKey, type VersionOut } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { GapList } from '@/components/GapList';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '@/components/ui';
import { gapsOf } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { invalidateStrategy } from '@/pages/strategy/queries';

function isSectionKey(key: string | null): key is SectionKey {
  return key !== null && (SECTION_KEYS as readonly string[]).includes(key);
}

/**
 * Approves the submitted draft once the user has gone through what it rests on: the assumptions
 * its consultation recorded without an answer, and how many hypotheses it puts in force (spec §5,
 * "onayda açıkça listelenir"). Nothing is sent until the user confirms here; the request names the
 * draft as it was shown (`stamp`), so a draft that changed since is refused rather than approved
 * unseen. `draft` is the draft to list (undefined while it loads: confirming waits for it).
 */
export function ApproveDialog({
  open,
  onOpenChange,
  draft,
  stamp,
  onApproved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: VersionOut | null | undefined;
  stamp: ApproveStamp;
  onApproved?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const approve = useMutation({
    mutationFn: approveDraft,
    onSuccess: async () => {
      toast.success(t('strategy.approved'));
      close(false);
      onApproved?.();
      await invalidateStrategy(queryClient);
    },
    onError: async (err) => {
      // The draft moved on: show it as it now stands behind the dialog.
      if (isApiError(err) && err.code === 'CONFLICT') await invalidateStrategy(queryClient);
    },
  });
  const close = (next: boolean) => {
    if (!next) approve.reset();
    onOpenChange(next);
  };
  const gaps = gapsOf(approve.error);
  const live = draft?.hypotheses.filter((h) => h.state !== 'retired').length;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('strategy.approveTitle', { number: draft?.number ?? '' })}</DialogTitle>
          <DialogDescription>{t('strategy.approveBody')}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <div className="flex flex-col gap-3 text-sm">
            <section aria-labelledby="approve-assumptions" className="flex flex-col gap-2">
              <h3 id="approve-assumptions" className="font-medium text-foreground">
                {t('strategy.approveAssumptions')}
              </h3>
              {draft.assumptions.length === 0 ? (
                <p className="text-muted-foreground">{t('strategy.approveNoAssumptions')}</p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                  {draft.assumptions.map((entry) => (
                    <li key={entry.id} className="rounded-md border border-border p-2.5">
                      <p className="whitespace-pre-wrap text-foreground">{entry.text}</p>
                      <p className="mt-1 text-caption text-muted-foreground">
                        {isSectionKey(entry.section_key) ? `${t(`strategy.sections.${entry.section_key}`)} · ` : ''}
                        <time dateTime={entry.at}>{formatDateTime(entry.at, i18n.language)}</time>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="text-foreground">{t('strategy.approveHypotheses', { count: live })}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('strategy.approveLoading')}</p>
        )}
        {gaps.length > 0 ? (
          <Callout tone="danger" title={t('strategy.gapsTitle')}>
            <GapList gaps={gaps} />
          </Callout>
        ) : (
          <ErrorCallout error={approve.error} />
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => approve.mutate(stamp)} loading={approve.isPending} disabled={!draft}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {t('strategy.approveConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
