import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { actOnCampaign, updateCampaign, type Campaign, type CampaignAction } from '@/api/ads';
import { MoneyInput } from '@/components/forms';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Field,
  Input,
  Textarea,
} from '@/components/ui';
import { CampaignError, isClosed, localDateTime, useCampaignMutation, validEnd } from './CampaignShared';

export function CampaignControls({ campaign: c, manage }: { campaign: Campaign; manage: boolean }) {
  const { t } = useTranslation();
  const [action, setAction] = useState<'decline' | 'pause' | 'end' | null>(null);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const act = useCampaignMutation(
    (input: { action: CampaignAction; reason?: string }) =>
      actOnCampaign(c.id, input.action, c.revision, input.reason),
    () => {
      setAction(null);
      setReason('');
    },
  );
  const state = c.state.state;
  if (isClosed(c) || (!manage && (state === 'proposed' || state === 'paused'))) return null;
  // The budget's own stop is lifted by the budget, never by a person's "resume".
  const byBudget = state === 'paused' && c.stop?.by === 'budget';
  // The reason is asked for a decline and a stop; an end is only confirmed.
  const needsReason = action !== 'end';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {state === 'proposed' ? (
          <>
            <Button loading={act.isPending} onClick={() => act.mutate({ action: 'approve' })}>
              {t('adCampaigns.approve')}
            </Button>
            <Button variant="outline" disabled={act.isPending} onClick={() => setAction('decline')}>
              {t('adCampaigns.decline')}
            </Button>
          </>
        ) : (
          <>
            {state !== 'paused' ? (
              <Button variant="outline" disabled={act.isPending} onClick={() => setAction('pause')}>
                {t('adCampaigns.pause')}
              </Button>
            ) : (
              !byBudget && (
                <Button disabled={act.isPending} onClick={() => act.mutate({ action: 'resume' })}>
                  {t('adCampaigns.resume')}
                </Button>
              )
            )}
            {manage && (
              <Button variant="outline" disabled={act.isPending} onClick={() => setAction('end')}>
                {t('adCampaigns.endAction')}
              </Button>
            )}
            {/* What is built at the ad platform carries the budget and the end it was built with. */}
            {manage && !c.built && (
              <Button variant="ghost" disabled={act.isPending} onClick={() => setEditing(true)}>
                {t('adCampaigns.edit')}
              </Button>
            )}
          </>
        )}
      </div>
      {!action && <CampaignError error={act.error} currency={c.currency} />}
      {action && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) {
              setAction(null);
              setReason('');
              act.reset();
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(action === 'end' ? 'adCampaigns.endTitle' : `adCampaigns.${action}`)}</DialogTitle>
              <DialogDescription>{c.title}</DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!needsReason) act.mutate({ action });
                else if (reason.trim()) act.mutate({ action, reason: reason.trim() });
              }}
            >
              {needsReason ? (
                <Field label={t('adCampaigns.reason')}>
                  {(ids) => (
                    <Textarea id={ids.id} required value={reason} onChange={(e) => setReason(e.target.value)} />
                  )}
                </Field>
              ) : (
                <p className="text-sm">{t('adCampaigns.endConfirm')}</p>
              )}
              <CampaignError error={act.error} currency={c.currency} />
              <Button disabled={needsReason && !reason.trim()} loading={act.isPending}>
                {t(action === 'end' ? 'adCampaigns.endAction' : `adCampaigns.${action}`)}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {editing && <EditCampaign campaign={c} onClose={() => setEditing(false)} />}
    </div>
  );
}
function EditCampaign({ campaign: c, onClose }: { campaign: Campaign; onClose: () => void }) {
  const { t } = useTranslation();
  const [budget, setBudget] = useState<number | null>(c.budget_minor);
  const [end, setEnd] = useState(localDateTime(c.end_at));
  const changed = budget !== c.budget_minor || end !== localDateTime(c.end_at);
  const valid = budget !== null && budget > 0 && (!end || validEnd(c.start_at, end));
  const save = useCampaignMutation(
    () =>
      updateCampaign(c.id, {
        expected_revision: c.revision,
        ...(budget !== c.budget_minor ? { budget_minor: budget! } : {}),
        ...(end !== localDateTime(c.end_at) ? { end_at: end ? new Date(end).toISOString() : null } : {}),
      }),
    onClose,
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('adCampaigns.edit')}</DialogTitle>
          <DialogDescription>{c.title}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && changed) save.mutate();
          }}
        >
          <Field label={t('adCampaigns.budget')}>
            {(ids) => (
              <MoneyInput id={ids.id} currency={c.currency} minor={budget} onChange={setBudget} required />
            )}
          </Field>
          <Field label={t('adCampaigns.end')}>
            {(ids) => (
              <Input
                className="min-w-0 max-w-full"
                id={ids.id}
                type="datetime-local"
                value={end}
                min={localDateTime(c.start_at)}
                onChange={(e) => setEnd(e.target.value)}
              />
            )}
          </Field>
          {!valid && <p role="alert">{t('adCampaigns.invalidEdit')}</p>}
          <CampaignError error={save.error} currency={c.currency} />
          <Button disabled={!valid || !changed} loading={save.isPending}>
            {t('adCampaigns.save')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
