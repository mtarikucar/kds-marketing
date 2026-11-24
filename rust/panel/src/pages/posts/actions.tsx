import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { areaRedo, deliveryAccept } from '@/api/content';
import * as m from '@/api/materials';
import {
  needsDraftGrant,
  postDismiss,
  versionCancel,
  type CancelRef,
  type PostRow,
  type Wait,
} from '@/api/postsPage';
import { projectGet, projectMaterials, projectRequestUpdate, projectUpdate } from '@/api/projects';
import { accountPause } from '@/api/social';
import * as studio from '@/api/studio';
import { Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle, toast } from '@/components/ui';
import { MaterialsError } from '../materials/MaterialsShared';
import { StudioError } from '../StudioShared';
import { PickTime } from './PickTime';
import { usePostsMutation, useInvalidatePosts, useUndoFailed } from './queries';
import { addFiles, PickFiles } from './SpecialDays';
import { channelAndTime, failNeedsRedo, whenWords } from './words';

/** What the panel's actions need from around them. */
export interface ActionContext {
  row: PostRow;
  /** Opens Hesaplar ("Hesap bağla"). */
  onAccounts: () => void;
  /** Opens the TikTok posting dialog over the row. */
  onTiktok: (slotId: string) => void;
  /**
   * A cancel of the row went through (`true`), or its `Geri al` did (`false`): the panel says the
   * row is gone without waiting for a read to say so.
   */
  onGone?: (rowId: string, gone: boolean) => void;
}

const fieldClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The consequence line of "Düzenleme iste" (§2.7.1), from the server's siblings. */
function siblingsLine(t: TFunction, row: PostRow, language: string): string[] {
  const unsent = row.siblings.filter((s) => s.status !== 'published' && s.status !== 'failed');
  const published = row.siblings.filter((s) => s.status === 'published');
  const lines: string[] = [];
  if (unsent.length) {
    lines.push(t('postsPage.redo.siblings', {
      count: unsent.length,
      list: unsent.map((s) => channelAndTime(t, s.channel, s.publish_at, language)).join(', '),
    }));
  }
  if (published.length) lines.push(t('postsPage.redo.published'));
  return lines;
}

/** "Düzenleme iste" and "Tekrar hazırlat" (§2.7.1): what should change, with what else it takes back. */
export function RedoDialog({ row, prefill, onClose }: { row: PostRow; prefill?: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [note, setNote] = useState(prefill ?? '');
  const redo = row.actions.redo!;
  const send = usePostsMutation(
    (value: string) => areaRedo(redo.project_id, { package_revision: redo.package_revision, note: value }),
    () => {
      toast.success(t('postsPage.panel.sentToAgent'));
      onClose();
    },
  );
  const text = note.trim();
  const lines = siblingsLine(t, row, i18n.language);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !send.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t('postsPage.redo.title')}</DialogTitle>
        <DialogDescription className="sr-only">{row.title}</DialogDescription>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (text && text.length <= 2000 && !send.isPending) send.mutate(text); }}>
          <label className="block">
            <span className="sr-only">{t('postsPage.redo.title')}</span>
            <textarea
              className={`${fieldClass} min-h-24`}
              required
              maxLength={2000}
              autoFocus
              placeholder={t('postsPage.redo.placeholder')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {lines.map((line) => <p key={line} className="text-sm text-muted-foreground">{line}</p>)}
          <StudioError error={send.error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('postsPage.redo.cancel')}</Button>
            <Button type="submit" disabled={!text} loading={send.isPending}>{t('postsPage.redo.send')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "İptal" (§2.7.2): the body by what is cancelled, an optional reason, and for a content `Geri al`. */
export function CancelDialog({ row, cancel, onClose, onGone }: { row: PostRow; cancel: CancelRef; onClose: () => void; onGone?: (rowId: string, gone: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const refresh = useInvalidatePosts();
  const undoFailed = useUndoFailed();
  const [reason, setReason] = useState('');
  const run = usePostsMutation(
    async (why: string) => {
      switch (cancel.kind) {
        case 'post':
          await studio.slotCancel(cancel.slot_id, cancel.expected_revision, why);
          return null;
        case 'version':
          await versionCancel(cancel.project_id, cancel.version_id, { package_revision: cancel.package_revision, reason: why });
          return null;
        case 'content':
          return projectUpdate(cancel.project_id, { expected_revision: cancel.expected_revision, archived: true });
      }
    },
    (archived) => {
      onClose();
      onGone?.(row.id, true);
      if (archived) {
        toast.success(t('postsPage.panel.cancelled'), {
          duration: 10_000,
          action: {
            label: t('postsPage.panel.undo'),
            onClick: () => {
              void projectUpdate(archived.id, { expected_revision: archived.revision, archived: false }).then(
                () => { onGone?.(row.id, false); return refresh(); },
                undoFailed,
              );
            },
          },
        });
      } else toast.success(t('postsPage.panel.cancelled'));
    },
  );
  const body = cancel.kind === 'post'
    ? t('postsPage.cancel.post', { post: channelAndTime(t, row.channel, row.publish_at, i18n.language) })
    : t(`postsPage.cancel.${cancel.kind}`);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !run.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t('postsPage.cancel.title')}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!run.isPending) run.mutate(reason.trim() || t('postsPage.cancel.defaultReason')); }}>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('postsPage.cancel.reason')}</span>
            <input className={fieldClass} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <StudioError error={run.error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('postsPage.cancel.back')}</Button>
            <Button type="submit" variant="destructive" loading={run.isPending}>{t('postsPage.cancel.confirm')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One action as a button; `quiet` ones are text buttons under the row of buttons. */
interface Act {
  key: string;
  node: ReactNode;
}

function useRowActs({ row, onAccounts, onTiktok, onGone }: ActionContext) {
  const { t, i18n } = useTranslation();
  const [dialog, setDialog] = useState<null | { kind: 'redo'; prefill?: string } | { kind: 'cancel' } | { kind: 'release' } | { kind: 'pick' }>(null);
  const a = row.actions;
  const wait: Wait | undefined = row.waits[0];
  // `permit_files` holds the pending files of both file waits; the shown wait's own are those its
  // facts name (a row can wait for a permission on one file and a quality tag on another).
  const own = wait?.facts.material_ids;
  const files = (a.permit_files ?? []).filter((f) => !own || own.includes(f.material_id));

  const approve = usePostsMutation(
    () => studio.approve({ slot: a.approve!.slot_id }, a.approve!.expected_revision),
    () => { toast.success(row.publish_at ? t('postsPage.panel.approved', { at: whenWords(t, row.publish_at, i18n.language) }) : t('postsPage.panel.approvedNow')); },
  );
  const permit = usePostsMutation(async () => { for (const f of files) await m.materialPermission(f.material_id, f.expected_revision, 'shareable'); });
  const useAnyway = usePostsMutation(async () => { for (const f of files) await m.materialTag(f.material_id, f.expected_revision, { quality: 'publishable' }); });
  const without = usePostsMutation(async () => {
    const area = row.area_id!;
    // The area's revision as the read gave it with the row's other area refs; the read has no ref
    // of its own for this action, so a viewer given neither reads the area first.
    const given = a.cancel?.kind === 'content' ? a.cancel.expected_revision
      : a.dismiss?.kind === 'capture' ? a.dismiss.expected_revision
        : a.accept_held?.expected_revision;
    const revision = given ?? (await projectGet(area)).project.revision;
    return projectMaterials(area, { expected_revision: revision, add: [], remove: files.map((f) => f.material_id) });
  });
  const accept = usePostsMutation(() => deliveryAccept(a.accept_held!.project_id, { expected_revision: a.accept_held!.expected_revision }));
  const acknowledge = usePostsMutation(() => postDismiss(a.acknowledge!.slot_id, a.acknowledge!.expected_revision));
  const resume = usePostsMutation(() => accountPause(a.resume_account!.capability_id, false, a.resume_account!.expected_revision));
  const add = usePostsMutation((picked: File[]) => addFiles(picked, a.add_files!));
  const dismiss = usePostsMutation(async (): Promise<unknown> => {
    const d = a.dismiss!;
    return d.kind === 'need'
      ? m.shootResolve(d.shoot_request_id, 'dismissed')
      : projectRequestUpdate(d.project_id, d.request_id, { expected_revision: d.expected_revision, status: 'dismissed' });
  });
  const release = usePostsMutation(async () => {
    const ref = a.release_check!;
    // `release_check` carries the slot's revision only; the release names the findings' digest,
    // which only the slot's own read gives.
    const detail = (await studio.slotGet(ref.slot_id)) as studio.SlotDetail & { material_check?: m.MaterialCheck };
    if (!detail.material_check) throw new Error('no_material_check');
    return m.materialCheckRelease(ref.slot_id, ref.expected_revision, detail.material_check.digest);
  }, () => setDialog(null));

  const btn = (key: string, label: string, onClick: () => void, opts: { primary?: boolean; loading?: boolean } = {}): Act => ({
    key,
    node: <Button key={key} size="sm" variant={opts.primary ? 'primary' : 'outline'} loading={opts.loading} onClick={onClick}>{label}</Button>,
  });
  const quiet = (key: string, label: string, onClick: () => void, loading?: boolean): Act => ({
    key,
    node: <Button key={key} size="sm" variant="ghost" className="px-1.5 underline underline-offset-4" loading={loading} onClick={onClick}>{label}</Button>,
  });
  const link = (key: string, label: string, to: string, primary = true): Act => ({
    key,
    node: <Button key={key} size="sm" variant={primary ? 'primary' : 'outline'} asChild><Link to={to}>{label}</Link></Button>,
  });
  const pick = (key: string, label: string, primary = false, variant: 'quiet' | 'button' = 'button'): Act => {
    const node = <PickFiles key={key} label={label} variant={variant === 'quiet' ? 'ghost' : primary ? 'primary' : 'outline'} loading={add.isPending} onFiles={(f) => add.mutate(f)} />;
    return { key, node };
  };
  const redoAct = (primary: boolean, prefill?: string, label = t('postsPage.actions.redo')): Act | null =>
    a.redo ? btn(prefill ? 'retry' : 'redo', label, () => setDialog({ kind: 'redo', prefill }), { primary }) : null;

  // The wait's primary action and its quiet secondary (§2.6).
  let primary: Act | null = null;
  let secondary: Act | null = null;
  // A line said under the buttons when the wait's action is someone else's to take.
  let note: string | null = null;
  switch (wait?.code) {
    case 'approval':
      primary = a.approve ? btn('approve', t('postsPage.actions.approve'), () => approve.mutate(undefined), { primary: true, loading: approve.isPending }) : null;
      break;
    case 'posting_screen':
      primary = a.tiktok ? btn('tiktok', t('postsPage.actions.tiktok'), () => onTiktok(a.tiktok!.slot_id), { primary: true }) : null;
      break;
    case 'capture':
      primary = a.add_files ? pick('add', t('postsPage.actions.addFile'), true) : null;
      secondary = a.dismiss ? quiet('dismiss', t('postsPage.actions.notNeeded'), () => dismiss.mutate(undefined), dismiss.isPending) : null;
      break;
    case 'need_photo':
      primary = a.add_files ? pick('add', t('postsPage.actions.addPhoto'), true) : null;
      secondary = a.dismiss ? quiet('dismiss', t('postsPage.actions.notNeeded'), () => dismiss.mutate(undefined), dismiss.isPending) : null;
      break;
    case 'files_permission':
      primary = files.length ? btn('permit', t('postsPage.actions.permit'), () => permit.mutate(undefined), { primary: true, loading: permit.isPending }) : null;
      secondary = row.kind === 'content' && row.area_id && files.length
        ? quiet('without', t('postsPage.actions.withoutFile'), () => without.mutate(undefined), without.isPending)
        : a.add_files ? pick('another', t('postsPage.actions.anotherPhoto'), false, 'quiet') : null;
      break;
    case 'files_quality':
      primary = files.length ? btn('use', t('postsPage.actions.useAnyway'), () => useAnyway.mutate(undefined), { primary: true, loading: useAnyway.isPending }) : null;
      secondary = row.kind === 'content' && row.area_id && files.length
        ? quiet('without', t('postsPage.actions.withoutFile'), () => without.mutate(undefined), without.isPending)
        : a.add_files ? pick('another', t('postsPage.actions.anotherPhoto'), false, 'quiet') : null;
      break;
    case 'delivery_held':
      primary = redoAct(true);
      secondary = a.accept_held ? quiet('accept', t('postsPage.actions.acceptHeld'), () => accept.mutate(undefined), accept.isPending) : null;
      break;
    case 'check_hold':
      primary = redoAct(true);
      secondary = a.release_check ? quiet('release', t('postsPage.actions.release'), () => setDialog({ kind: 'release' })) : null;
      break;
    case 'failed':
      // An unaudited refusal is answered with a draft: without the draft grant, reconnect first.
      if (((wait.facts.reason === 'auth' || wait.facts.reason === 'permission') && !wait.facts.recovered) || needsDraftGrant(wait.facts)) {
        // The account still cannot post: preparing it again would fail the same way (§2.6).
        if (a.reconnect) primary = link('reconnect', t('postsPage.actions.reconnect'), `/connect?capability=${encodeURIComponent(a.reconnect)}`);
        else note = t('postsPage.panel.managerReconnect');
      } else if (failNeedsRedo(wait)) primary = redoAct(true);
      else primary = redoAct(true, t('postsPage.redo.retryText'), t('postsPage.actions.retry'));
      secondary = a.acknowledge ? quiet('dismiss', t('postsPage.actions.dismiss'), () => acknowledge.mutate(undefined), acknowledge.isPending) : null;
      break;
    case 'tiktok_draft':
      primary = a.acknowledge ? btn('done', t('postsPage.actions.done'), () => acknowledge.mutate(undefined), { primary: true, loading: acknowledge.isPending }) : null;
      break;
    case 'no_account':
      primary = a.connect ? btn('connect', t('postsPage.actions.connect'), onAccounts, { primary: true }) : null;
      break;
    case 'no_account_for_platform':
      primary = a.connect ? btn('connect', t('postsPage.actions.connect'), onAccounts, { primary: true }) : null;
      secondary = a.redo ? quiet('redo', t('postsPage.actions.redo'), () => setDialog({ kind: 'redo' })) : null;
      break;
    case 'account_unavailable':
      primary = a.reconnect ? link('reconnect', t('postsPage.actions.reconnect'), `/connect?capability=${encodeURIComponent(a.reconnect)}`) : null;
      break;
    case 'account_paused':
      primary = a.resume_account ? btn('resume', t('postsPage.actions.resume'), () => resume.mutate(undefined), { primary: true, loading: resume.isPending }) : null;
      break;
    case 'media':
    case 'material_removed':
      primary = redoAct(true);
      break;
    case 'knowledge_empty':
      primary = link('knowledge', t('postsPage.actions.toKnowledge'), '/knowledge');
      break;
    case 'no_agent':
      primary = link('agents', t('postsPage.actions.connectAgent'), '/agents');
      break;
    case 'pick_time':
      primary = a.pick_time ? btn('pick', t('postsPage.actions.pickTime'), () => setDialog({ kind: 'pick' }), { primary: true }) : null;
      break;
  }

  // Then Onayla or TikTok ekranında onayla when not the primary, Düzenleme iste, İptal (§2.7 item 3).
  const row2: Act[] = [];
  if (primary) row2.push(primary);
  if (a.approve && primary?.key !== 'approve') row2.push(btn('approve', t('postsPage.actions.approve'), () => approve.mutate(undefined), { loading: approve.isPending }));
  if (a.tiktok && primary?.key !== 'tiktok') row2.push(btn('tiktok', t('postsPage.actions.tiktok'), () => onTiktok(a.tiktok!.slot_id)));
  if (a.redo && note == null && !row2.some((x) => x.key === 'redo' || x.key === 'retry') && secondary?.key !== 'redo') row2.push(btn('redo', t('postsPage.actions.redo'), () => setDialog({ kind: 'redo' })));
  if (a.cancel) row2.push(btn('cancel', t('postsPage.actions.cancel'), () => setDialog({ kind: 'cancel' })));
  // A version an account can take: a person may give its time now (§2.12 #23).
  const quiets: Act[] = [];
  if (secondary) quiets.push(secondary);
  if (a.pick_time && wait?.code !== 'pick_time') quiets.push(quiet('pickMyself', t('postsPage.actions.pickMyself'), () => setDialog({ kind: 'pick' })));

  const errors = [approve, permit, useAnyway, without, accept, acknowledge, resume, add, dismiss].map((x) => x.error).find((e) => e != null);
  const dialogs = (
    <>
      {dialog?.kind === 'redo' && a.redo && <RedoDialog row={row} prefill={dialog.prefill} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && a.cancel && <CancelDialog row={row} cancel={a.cancel} onClose={() => setDialog(null)} onGone={onGone} />}
      {dialog?.kind === 'release' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => { if (!open && !release.isPending) setDialog(null); }}
          title={t('materials.hold.releaseTitle')}
          description={t('materials.hold.releaseHelp')}
          confirmLabel={t('materials.hold.releaseConfirm')}
          cancelLabel={t('postsPage.cancel.back')}
          loading={release.isPending}
          onConfirm={() => { if (!release.isPending) release.mutate(undefined); }}
        />
      )}
    </>
  );
  return { buttons: row2, quiets, note, error: errors ?? release.error, dialogs, picking: dialog?.kind === 'pick' && a.pick_time ? a.pick_time : null };
}

/**
 * The panel's actions (§2.7 item 3): one row of buttons, only those the server says this viewer
 * may take, in the spec's order; the wait's secondary as a text button under them. No action: no
 * button row.
 */
export function RowActionBar(ctx: ActionContext) {
  const acts = useRowActs(ctx);
  if (!acts.buttons.length && !acts.quiets.length && !acts.picking && !acts.note) return acts.dialogs;
  return (
    <div className="space-y-2">
      {acts.note && <p className="text-sm text-muted-foreground">{acts.note}</p>}
      {acts.buttons.length > 0 && <div role="group" aria-label={ctx.row.title} className="flex flex-wrap gap-2">{acts.buttons.map((b) => b.node)}</div>}
      {acts.quiets.length > 0 && <div className="flex flex-wrap gap-x-3">{acts.quiets.map((b) => b.node)}</div>}
      {acts.picking && <PickTime pick={acts.picking} format={ctx.row.format} />}
      {acts.error != null && <MaterialsError error={acts.error} />}
      {acts.dialogs}
    </div>
  );
}
