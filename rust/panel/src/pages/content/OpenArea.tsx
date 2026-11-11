import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listCapabilities } from '@/api/capabilities';
import { projectCreate } from '@/api/projects';
import { POST_FORMATS, type PostFormat } from '@/api/posts';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui';
import { fieldClass, MaterialsReadStatus, useMaterialsKey, useMaterialsMutation } from '../materials/MaterialsShared';
import { ProjectError, useRequestKey } from '../projects/ProjectShared';

export function OpenArea({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [goal, setGoal] = useState('');
  const [start, setStart] = useState(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [account, setAccount] = useState('');
  const [format, setFormat] = useState<PostFormat | ''>('');
  const keyFor = useRequestKey();
  const accounts = useQuery({ queryKey: [...key, 'social-accounts'], queryFn: () => listCapabilities({ group: 'social_account', status: 'verified' }) });
  const create = useMaterialsMutation(() => {
    const input = { brief: goal.trim(), start_at: new Date(start).toISOString(), ...(account ? { capability_ids: [account] } : {}), ...(format ? { formats: [format] } : {}) };
    return projectCreate({ ...input, request_key: keyFor(input) });
  }, result => onCreated(result.id));
  return <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose(); }}>
    <DialogContent dismissible={!create.isPending}>
      <DialogTitle>{t('contentAreas.open')}</DialogTitle>
      <DialogDescription>{t('contentAreas.openHelp')}</DialogDescription>
      <form className="min-w-0 space-y-4" onSubmit={e => { e.preventDefault(); if (goal.trim() && start && !create.isPending) create.mutate(undefined); }}>
        <label className="block space-y-2 text-sm"><span>{t('contentAreas.goal')}</span><textarea className={fieldClass} required maxLength={2000} value={goal} onChange={e => setGoal(e.target.value)} /></label>
        <label className="block min-w-0 space-y-2 text-sm"><span>{t('contentAreas.start')}</span><input className={`${fieldClass} min-w-0 max-w-full`} type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
        <details><summary className="cursor-pointer text-sm">{t('contentAreas.optional')}</summary><div className="mt-3 space-y-3">
          <label className="block space-y-2 text-sm"><span>{t('contentAreas.platform')}</span><select className={fieldClass} value={account} onChange={e => setAccount(e.target.value)}><option value="">{t('contentAreas.agentChooses')}</option>{accounts.data?.map(({ capability: c }) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <MaterialsReadStatus query={accounts} />
          <label className="block space-y-2 text-sm"><span>{t('contentAreas.format')}</span><select className={fieldClass} value={format} onChange={e => setFormat(e.target.value as PostFormat | '')}><option value="">{t('contentAreas.agentChooses')}</option>{POST_FORMATS.map(f => <option key={f} value={f}>{t(`posts.format.${f}`)}</option>)}</select></label>
        </div></details>
        <ProjectError error={create.error} />
        <Button type="submit" loading={create.isPending} disabled={!goal.trim() || !start}>{t('contentAreas.open')}</Button>
      </form>
    </DialogContent>
  </Dialog>;
}
