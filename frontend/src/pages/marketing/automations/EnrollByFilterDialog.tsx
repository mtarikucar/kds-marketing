import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UserPlus, AlertTriangle } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Callout } from '@/components/ui/Callout';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/Dialog';

/**
 * Bulk-enroll every lead matching an audience filter into a workflow (drip
 * sequence entry — Epic 9c). The server fans out in a background batch job and
 * returns the queued count immediately. Enrolling the WHOLE list (no filter) is
 * high blast-radius, so it's gated behind an explicit "enroll all" confirmation.
 * Enrollment is idempotent per (workflow, lead).
 */
export function EnrollByFilterDialog({ workflowId, workflowName, open, onOpenChange }: {
  workflowId: string; workflowName: string; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('marketing');
  const [status, setStatus] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [search, setSearch] = useState('');
  const [enrollAll, setEnrollAll] = useState(false);

  const hasFilter = !!(status || businessType || search);
  // With no filter set, the operator must tick "enroll all" — mirrors the
  // server-side guard so a blank submit can't silently mass-enroll the list.
  const canSubmit = hasFilter || enrollAll;

  const enroll = useMutation({
    mutationFn: () => marketingApi.post('/leads/enroll-by-filter', {
      workflowId,
      status: status || undefined,
      businessType: businessType || undefined,
      search: search || undefined,
      enrollAll: !hasFilter && enrollAll ? true : undefined,
    }).then((r) => r.data),
    onSuccess: (res: { queued: number }) => {
      toast.success(t('automations.enrollQueued', 'Enrolling {{n}} contacts in the background', { n: res.queued }));
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('automations.enrollFailed', 'Could not enroll')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('automations.enrollTitle', 'Enroll contacts')}</DialogTitle>
          <DialogDescription>
            {t('automations.enrollHint', 'Add every contact matching this filter into “{{name}}”.', { name: workflowName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={t('automations.filterStatus', 'Status (optional)')}>
            {({ id }) => <Input id={id} value={status} placeholder="NEW, CONTACTED, …" onChange={(e) => setStatus(e.target.value.trim())} />}
          </Field>
          <Field label={t('automations.filterBusinessType', 'Business type (optional)')}>
            {({ id }) => <Input id={id} value={businessType} placeholder="CAFE, RESTAURANT, …" onChange={(e) => setBusinessType(e.target.value.trim())} />}
          </Field>
          <Field label={t('automations.filterSearch', 'Search name/email (optional)')}>
            {({ id }) => <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} />}
          </Field>

          {/* Whole-list enroll gate — only when no filter narrows the audience. */}
          {!hasFilter && (
            <Callout tone="warning">
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox checked={enrollAll} onCheckedChange={(v) => setEnrollAll(v === true)} className="mt-0.5" />
                <span className="flex items-center gap-1 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t('automations.enrollAll', 'Enroll ALL contacts — this starts sending messages and cannot be undone')}
                </span>
              </label>
            </Callout>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => enroll.mutate()} loading={enroll.isPending} disabled={!canSubmit || enroll.isPending}>
            <UserPlus className="h-4 w-4" />{t('automations.enrollBtn', 'Enroll')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
