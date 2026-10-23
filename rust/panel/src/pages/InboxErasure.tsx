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
    <Button variant="destructive" onClick={() => { setConfirmed(''); setOpen(true); }}>{t('inbox.erasure.open')}</Button>
    <Dialog open={open} onOpenChange={value => { if (!erase.isPending) setOpen(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('inbox.erasure.open')}</DialogTitle><DialogDescription>{t('inbox.erasure.description')}</DialogDescription></DialogHeader>
        <label className="text-sm">{t('inbox.erasure.confirm', { phrase: t('inbox.erasure.phrase') })}<Input autoComplete="off" value={confirmed} onChange={e => setConfirmed(e.target.value)} /></label>
        {erase.error && <ErrorCallout error={erase.error} />}
        <DialogFooter><Button variant="destructive" disabled={confirmed !== t('inbox.erasure.phrase') || erase.isPending} onClick={() => erase.mutate()}>{t('inbox.erasure.submit')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
