import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronLeft, Upload } from 'lucide-react';
import { analysisQueue, contentTree, GENEL, olayView, type QueueItem, type QueueStage, type TreeOut } from '@/api/content';
import * as m from '@/api/materials';
import { AgentWakeLine } from '@/components/AgentWakeLine';
import { QueryState } from '@/components/QueryState';
import { Button, cn, ConfirmDialog, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui';
import { ConfirmOlay, OlayDialog } from '../content/OlayForms';
import { UploadProvider, useUploads } from '../content/uploads';
import { MaterialEditor } from '../materials/MaterialEditor';
import {
  fieldClass,
  formatRange,
  MaterialPreview,
  materialLabel,
  MaterialsError,
  useDecider,
  useMaterialsKey,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { closedPlace, type PostsPlace } from './location';

/** A person files an analysed upload nobody filed: a category, or Genel (`studio.material_bind`). */
function FileInto({ item, tree }: { item: QueueItem; tree: TreeOut }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState('');
  const bind = useMaterialsMutation(() =>
    m.materialBind(item.material.id, item.material.revision, target === GENEL ? { kind: 'genel' } : { kind: 'olay', olay_id: target }),
  );
  const label = `${t('content.queue.fileInto')} · ${materialLabel(t, item.material)}`;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (target && !bind.isPending) bind.mutate(undefined);
      }}
    >
      <select aria-label={label} className={`${fieldClass} w-auto min-w-[10rem] flex-1`} value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{t('content.queue.choose')}</option>
        {tree.olays.map((o) => <option key={o.olay.id} value={o.olay.id}>{o.olay.title}</option>)}
        <option value={GENEL}>{t('content.genel')}</option>
      </select>
      <Button type="submit" size="sm" disabled={!target} loading={bind.isPending}>{t('content.queue.file')}</Button>
      <div className="basis-full empty:hidden"><MaterialsError error={bind.error} /></div>
    </form>
  );
}

/** Erases an upload nobody could place (`studio.material_delete`). */
function Erase({ item }: { item: QueueItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const remove = useMaterialsMutation(() => m.materialDelete(item.material.id, item.material.revision), () => setOpen(false));
  return (
    <>
      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setOpen(true)}>{t('content.queue.erase')}</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !remove.isPending && setOpen(next)}
        title={t('materials.editor.deleteTitle')}
        description={t('materials.editor.deleteKvkk')}
        confirmLabel={t('materials.editor.deleteConfirm')}
        cancelLabel={t('materials.editor.deleteCancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => { if (!remove.isPending) remove.mutate(undefined); }}
      />
      <MaterialsError error={remove.error} />
    </>
  );
}

/** "Tekrar dene" on a file whose analysis did not finish. */
function Retry({ item }: { item: QueueItem }) {
  const { t } = useTranslation();
  const retry = useMaterialsMutation(() => m.materialAnalysisRetry(item.material.id, item.material.revision));
  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant="outline" loading={retry.isPending} onClick={() => retry.mutate(undefined)}>{t('postsPage.files.retry')}</Button>
      <MaterialsError error={retry.error} />
    </span>
  );
}

type Chip = 'all' | 'queue' | 'unshared';

/** A file's small state word (§2.9.1): its place in the analysis queue, else a missing permission. */
function stateWord(t: TFunction, stage: QueueStage | undefined, material: m.Material): { text: string; tone: string } | null {
  if (stage === 'waiting') return { text: t('postsPage.files.state.waiting'), tone: 'text-muted-foreground' };
  if (stage === 'analysing') return { text: t('postsPage.files.state.analysing'), tone: 'text-info' };
  if (stage === 'needs_filing') return { text: t('postsPage.files.state.needs_filing'), tone: 'text-warning' };
  if (stage === 'failed') return { text: t('postsPage.files.state.failed'), tone: 'text-danger' };
  if (!material.share && !material.erased_at) return { text: t('postsPage.files.state.unshared'), tone: 'text-warning' };
  return null;
}

/** One file of the grid: its picture, its title and its state word; it opens the editor. */
function FileTile({ material, item, tree, onOpen }: { material: m.Material; item?: QueueItem; tree?: TreeOut; onOpen: () => void }) {
  const { t } = useTranslation();
  const decider = useDecider();
  const word = stateWord(t, item?.stage, material);
  const label = materialLabel(t, material);
  return (
    <li className="min-w-0 space-y-1">
      <button type="button" onClick={onOpen} title={label} className="group block w-full min-w-0 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="relative block aspect-square overflow-hidden rounded-md border border-border bg-surface-muted group-hover:border-border-strong [&>div]:h-full [&_[role=img]]:h-full [&_[role=img]]:rounded-none [&_img]:h-full [&_img]:rounded-none [&_.text-xs]:hidden [&_video]:h-full [&_video]:rounded-none [&_video]:object-cover">
          <MaterialPreview material={material} />
        </span>
        <span className="mt-1 block truncate text-xs font-medium">{label}</span>
        {word && <span className={cn('block text-[0.6875rem] leading-tight', word.tone)}>{word.text}</span>}
      </button>
      {item?.stage === 'failed' && <Retry item={item} />}
      {item?.stage === 'needs_filing' && item.unfiled && tree && (decider
        ? <div className="space-y-1"><FileInto item={item} tree={tree} /><Erase item={item} /></div>
        : <p className="text-xs text-muted-foreground">{t('content.queue.managerFiles')}</p>)}
    </li>
  );
}

function UploadButton() {
  const { t } = useTranslation();
  const uploads = useUploads();
  if (!uploads) return null;
  return (
    <Button size="sm" onClick={uploads.pick}>
      <Upload aria-hidden="true" className="h-4 w-4" />
      {t('postsPage.files.upload')}
    </Button>
  );
}

/**
 * Dosyalar (design 2026-11-19 §2.9.1): the file library and its analysis queue in one drawer.
 * `Yükle` puts files in the library (unfiled, into analysis, as before); the chips show the
 * queue and the files waiting for a permission; the category select narrows to one olay (named
 * `Kategori` to the owner) or Genel, where a category is added or edited. Proposed categories
 * wait for a confirmation in their own block (not in "Seni bekleyen", D8). A file opens the
 * library's editor, unchanged.
 */
export function FilesDrawer({ place, go }: { place: PostsPlace; go: (next: PostsPlace, options?: { replace?: boolean }) => void }) {
  const { t, i18n } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const [editing, setEditing] = useState<m.Olay | 'new' | null>(null);
  const chip: Chip = place.queue ? 'queue' : 'all';
  const [unshared, setUnshared] = useState(false);
  const category = place.category;
  const tree = useQuery({ queryKey: [...key, 'posts-files', 'tree'], queryFn: contentTree, refetchInterval: 30_000 });
  const queue = useQuery({ queryKey: [...key, 'posts-files', 'queue'], queryFn: analysisQueue, refetchInterval: 15_000 });
  const all = useQuery({ queryKey: [...key, 'posts-files', 'all'], queryFn: () => m.materialsList({ state: 'live' }), enabled: !category });
  const folder = useQuery({ queryKey: [...key, 'posts-files', 'folder', category], queryFn: () => olayView(category!), enabled: !!category });
  const items = queue.data?.items ?? [];
  const stageOf = new Map(items.map((i) => [i.material.id, i]));
  const files: m.Material[] = category ? (folder.data?.files ?? []).map((f) => f.material).filter((x) => !x.erased_at) : all.data ?? [];
  const shown = chip === 'queue' ? items.map((i) => i.material) : unshared ? files.filter((x) => !x.share) : files;
  const unsharedCount = files.filter((x) => !x.share).length;
  const olays = tree.data?.olays ?? [];
  const proposed = olays.filter((o) => o.olay.status === 'proposed');
  const chosen = olays.find((o) => o.olay.id === category)?.olay;
  const waiting = items.filter((i) => i.stage === 'waiting').length;
  const close = () => go(closedPlace(place), { replace: true });
  const open = (file: string | undefined) => go({ ...place, files: true, file }, {});
  const read = chip === 'queue' ? queue : category ? folder : all;
  const chipButton = (value: 'all' | 'queue' | 'unshared', label: string, count?: number) => {
    const on = value === 'unshared' ? unshared && chip === 'all' : value === chip && !(value === 'all' && unshared);
    return (
      <button
        key={value}
        type="button"
        aria-pressed={on}
        onClick={() => {
          if (value === 'queue') { setUnshared(false); go({ ...place, queue: true }, { replace: true }); }
          else { setUnshared(value === 'unshared'); go({ ...place, queue: undefined }, { replace: true }); }
        }}
        className={cn('inline-flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm', on ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border bg-surface')}
      >
        {label}
        {count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
      </button>
    );
  };
  return (
    <UploadProvider enabled dropAnywhere={false}>
      <Sheet open onOpenChange={(next) => { if (!next) close(); }}>
        <SheetContent side="right" className="w-full max-w-none overflow-y-auto sm:max-w-2xl">
          {place.file ? (
            <div className="space-y-3">
              <button type="button" className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground" onClick={() => open(undefined)}>
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                {t('postsPage.files.title')}
              </button>
              <SheetTitle className="sr-only">{t('postsPage.files.file')}</SheetTitle>
              <SheetDescription className="sr-only">{t('postsPage.files.help')}</SheetDescription>
              <MaterialEditor
                key={place.file}
                id={place.file}
                onOpenOlay={(olay) => go({ ...place, file: undefined, category: olay }, {})}
                onOpenSlot={(slot) => go({ slot }, {})}
                onOpenMaterial={(file) => open(file)}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <SheetHeader className="flex flex-row flex-wrap items-center gap-3 pe-8">
                <SheetTitle>{t('postsPage.files.title')}</SheetTitle>
                <SheetDescription className="sr-only">{t('postsPage.files.help')}</SheetDescription>
                <span className="flex-1" />
                <UploadButton />
              </SheetHeader>
              <AgentWakeLine need="materials" waiting={waiting} />
              <div className="flex flex-wrap items-center gap-2">
                <div role="group" aria-label={t('postsPage.chips.label')} className="flex flex-wrap gap-2">
                  {chipButton('all', t('postsPage.files.all'))}
                  {chipButton('queue', t('postsPage.files.queue'), items.length)}
                  {chipButton('unshared', t('postsPage.files.unshared'), unsharedCount)}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <span>{t('postsPage.files.category')}:</span>
                  <select
                    className={`${fieldClass} w-auto min-w-[9rem]`}
                    value={category ?? ''}
                    onChange={(e) => go({ ...place, category: e.target.value || undefined }, { replace: true })}
                  >
                    <option value="">{t('postsPage.files.allCategories')}</option>
                    <option value={GENEL}>{t('postsPage.panel.genel')}</option>
                    {olays.map((o) => <option key={o.olay.id} value={o.olay.id}>{o.olay.title}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="outline" onClick={() => setEditing('new')}>{t('postsPage.files.addCategory')}</Button>
                {chosen && (decider || chosen.status === 'proposed') && <Button size="sm" variant="ghost" onClick={() => setEditing(chosen)}>{t('postsPage.files.edit')}</Button>}
              </div>
              {proposed.length > 0 && (
                <section aria-label={t('postsPage.files.proposed')} className="space-y-2 rounded-lg border border-border bg-surface-muted/40 p-3">
                  <h3 className="text-sm font-semibold">{t('postsPage.files.proposed')}</h3>
                  <ul className="space-y-2">
                    {proposed.map((o) => (
                      <li key={o.olay.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1">{o.olay.title} · {formatRange(o.olay.starts_on, o.olay.ends_on, i18n.language)}</span>
                        {decider && <ConfirmOlay olay={o.olay} />}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <QueryState query={read} keepOnError>
                {read.data !== undefined && (shown.length ? (
                  <ul aria-label={t('postsPage.files.grid')} className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-2.5 gap-y-3">
                    {shown.map((x) => <FileTile key={x.id} material={x} item={stageOf.get(x.id)} tree={tree.data} onOpen={() => open(x.id)} />)}
                  </ul>
                ) : (
                  <p className="rounded-md border border-dashed border-border-strong px-3 py-4 text-center text-sm text-muted-foreground">{t('postsPage.files.empty')}</p>
                ))}
              </QueryState>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {editing && (
        <OlayDialog
          key={editing === 'new' ? 'new' : editing.revision}
          olay={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => go({ ...place, category: saved.id }, { replace: true })}
        />
      )}
    </UploadProvider>
  );
}
