import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2, Download, Trash2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { fmtDateTime } from '@/features/marketing/utils/format';
import {
  useComplianceMutations,
  useLeadConsents,
} from '../settings/compliance/hooks';
import type { ConsentRecord } from '../settings/compliance/types';

export interface PersonConsentsProps {
  /** Whose consent record. */
  leadId: string;
}

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * `ONAYLAR VE VERİ TALEPLERİ` — what this person consented to, and the two
 * data-subject actions, as a section of their record card.
 *
 * ## Why this is here and not a link to /settings/compliance
 *
 * That page's FIRST step is a lead search: type two characters, read a list,
 * click the person. The Inbox has already selected them. So the merge is not
 * cosmetic — it deletes a whole step, and it deletes exactly the step that was
 * hardest to get right (which "Ayşe" did the caller mean?). The page keeps the
 * search for the case this section cannot serve: somebody who wrote in by email
 * quoting a name nobody has a conversation with.
 *
 * The hooks are `settings/compliance/hooks` verbatim — same keys, same
 * fetchers, so an erasure requested here lands in the same request history the
 * Studio's `?tool=ops` drawer reads, with no second cache to invalidate.
 *
 * Mounted only while its disclosure is open, so a rep clicking through a queue
 * never pays for this read. The MANAGER gate is on the CALLER
 * (`LeadContextPane`), mirroring `ComplianceController`'s class-level
 * `@MarketingRoles('MANAGER')` — a rep may not read anyone's consent record.
 *
 * NO LINK. The record card offers exactly one way off the surface and a test
 * counts them; "see the full compliance console" would be a second.
 */
export function PersonConsents({ leadId }: PersonConsentsProps) {
  const { t } = useTranslation('marketing');
  const [erasureOpen, setErasureOpen] = useState(false);
  const { data: consents, isLoading } = useLeadConsents(leadId);
  const { exportData, erasure } = useComplianceMutations();

  const handleExport = () =>
    exportData.mutate(leadId, {
      onSuccess: (bundle) => {
        downloadJson(`lead-${leadId}-export.json`, bundle);
        toast.success(t('compliance.exportDone', 'Data export downloaded'));
      },
      onError: (e) => toast.error(apiError(e, t('compliance.exportError', 'Failed to export data'))),
    });

  const handleErasure = () =>
    erasure.mutate(leadId, {
      onSuccess: () => {
        setErasureOpen(false);
        toast.success(t('compliance.erasureDone', 'Erasure request recorded (pending review)'));
      },
      onError: (e) =>
        toast.error(apiError(e, t('compliance.erasureError', 'Failed to request erasure'))),
    });

  return (
    <div data-testid="person-consents" className="space-y-2">
      {isLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : (consents ?? []).length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {t('compliance.noConsent', 'No consent records for this lead.')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {(consents as ConsentRecord[]).map((c) => (
            <li
              key={c.type}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-2 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {c.granted ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
                )}
                <span className="truncate text-xs text-foreground">
                  {t(`compliance.consentType.${c.type}`, c.type.replace(/_/g, ' '))}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge tone={c.granted ? 'success' : 'neutral'} size="sm">
                  {c.granted
                    ? t('compliance.granted', 'Granted')
                    : t('compliance.withdrawn', 'Withdrawn')}
                </Badge>
                <span className="text-[10px] text-muted-foreground">{fmtDateTime(c.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={handleExport} loading={exportData.isPending}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t('compliance.requestExport', 'Export data')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-danger"
          onClick={() => setErasureOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('compliance.requestErasure', 'Request erasure')}
        </Button>
      </div>
      {/* Said out loud, because "Silme talebi" on a person's card reads like a
          delete button. It records a PENDING request for review; nothing is
          deleted by clicking it. */}
      <p className="text-[10px] text-muted-foreground">
        {t(
          'compliance.actionsHint',
          'Export downloads the data bundle now. Erasure is recorded as pending for review — it never auto-deletes.',
        )}
      </p>

      <ConfirmDialog
        open={erasureOpen}
        onOpenChange={setErasureOpen}
        title={t('compliance.erasureTitle', 'Request data erasure')}
        description={t(
          'compliance.erasureDesc',
          'This records a PENDING erasure request for review. No data is deleted automatically.',
        )}
        confirmLabel={t('compliance.requestErasure', 'Request erasure')}
        cancelLabel={t('common.cancel', 'Cancel')}
        tone="danger"
        loading={erasure.isPending}
        onConfirm={handleErasure}
      />
    </div>
  );
}
