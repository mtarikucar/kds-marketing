import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Input, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { erasePerson } from '@/api/inbox';
import { useInboxKey, useInboxMutation } from './InboxShared';

export function InboxErasure({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const client = useQueryClient();
  const key = useInboxKey();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState('');
  const erase = useInboxMutation(() => erasePerson(personId), () => {
    client.removeQueries({ queryKey: key });
    client.removeQueries({ queryKey: ['ledger'] });
    setOpen(false);
    navigate('/inbox');
  });
  if (!can(session.data, 'inbox.manage')) return null;
  return <>
    {/* Irreversible, so a quiet entry point; the typed confirmation in the dialog is the real gate. */}
    <Button variant="ghost" size="sm" className="self-start text-danger" onClick={() => { erase.reset(); setConfirmed(''); setOpen(true); }}>{t('inbox.erasure.open')}</Button>
    <Dialog open={open} onOpenChange={value => { if (!erase.isPending) setOpen(value); }}>
      <DialogContent dismissible={!erase.isPending}>
        <DialogHeader className="pr-7"><DialogTitle>{t('inbox.erasure.open')}</DialogTitle><DialogDescription className="leading-6">{t('inbox.erasure.description')}</DialogDescription></DialogHeader>
        <label className="flex min-w-0 flex-col gap-3 rounded-lg border border-danger bg-danger-subtle p-4 text-sm leading-6">{t('inbox.erasure.confirm', { phrase: t('inbox.erasure.phrase') })}<Input autoComplete="off" disabled={erase.isPending} value={confirmed} onChange={e => setConfirmed(e.target.value)} /></label>
        {erase.error && <ErrorCallout error={erase.error} />}
        <DialogFooter>
          <Button variant="outline" disabled={erase.isPending} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={confirmed !== t('inbox.erasure.phrase')} loading={erase.isPending} onClick={() => { if (confirmed === t('inbox.erasure.phrase')) erase.mutate(); }}>{t('inbox.erasure.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
