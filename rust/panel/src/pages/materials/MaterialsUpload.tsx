import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Camera, Upload } from 'lucide-react';
import * as m from '@/api/materials';
import { fileUpload } from '@/api/studio';
import { Badge } from '@/components/ui';
import { captureTime } from '@/lib/capture';
import {
  MaterialsError,
  MaterialsReadStatus,
  MediaThumb,
  OlayFields,
  OlayLine,
  ProposedBadge,
  TagsFields,
  cardClass,
  emptyOlay,
  emptyTags,
  olayDraftProblem,
  olayInput,
  primaryClass,
  tapClass,
  useDecider,
  useMaterialsKey,
  useMaterialsMutation,
  type OlayDraft,
} from './MaterialsShared';

/** What the file store takes (`studio.file_upload`), and up to which size. */
const LIMITS: Record<string, number> = {
  'image/jpeg': 25_000_000,
  'image/png': 25_000_000,
  'image/webp': 25_000_000,
  'image/gif': 25_000_000,
  'video/mp4': 200_000_000,
};

type Status = 'refused' | 'uploading' | 'uploaded' | 'failed' | 'added' | 'add_failed';
interface Item {
  /** The upload's request key; the material's is derived from it, so a retry replays. */
  key: string;
  file: File;
  preview: string | null;
  /** When it was taken, by its bytes or (else) the device's file time. */
  captured: Date | null;
  status: Status;
  fileId?: string;
  error?: unknown;
  added?: m.MaterialAddOut;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function preview(file: File): string | null {
  if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/** The device's own time for the file, when it is a plausible capture time (not in the future). */
function fileTime(file: File): Date | null {
  return file.lastModified && file.lastModified <= Date.now() ? new Date(file.lastModified) : null;
}

/** The olay choice: an olay's id, a new olay, or genel. */
type Choice = string | 'new' | 'genel' | '';

/**
 * Yükle: pick or shoot photos and videos; each is stored at once (`studio.file_upload`), then one
 * short form adds the batch to the library: its olay (suggested by the capture day), the share
 * permission (mandatory from an owner or manager) and optional tags.
 */
export function MaterialsUpload({
  presetOlay,
  onOpenOlay,
}: {
  presetOlay?: string;
  onOpenOlay: (id: string) => void;
}) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const [items, setItems] = useState<Item[]>([]);
  const [choice, setChoice] = useState<Choice>(presetOlay ?? '');
  const [draft, setDraft] = useState<OlayDraft>(() => emptyOlay());
  const [permission, setPermission] = useState<m.SharePermission | ''>('');
  const [tags, setTags] = useState<m.Tags>(emptyTags);
  const [problem, setProblem] = useState<'olay' | 'permission' | 'title' | 'dates' | 'occasion' | null>(
    null,
  );
  /** The olay this batch created, so a retry never creates it twice. */
  const [created, setCreated] = useState<m.Olay | null>(null);
  const olayKey = useRef<string | null>(null);
  const busy = useRef(false);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const olays = useQuery({ queryKey: [...key, 'olays'], queryFn: () => m.olaysList() });
  const year = Number((draft.starts_on || m.istanbulDay(new Date())).slice(0, 4));
  const calendar = useQuery({
    queryKey: [...key, 'calendar', year],
    queryFn: () => m.calendarList(year),
    enabled: choice === 'new' && m.isSeasonal(draft.kind),
  });

  // Previews belong to this page: free them when it goes.
  const previews = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL?.(url);
    },
    [],
  );

  const patch = (itemKey: string, change: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === itemKey ? { ...i, ...change } : i)));

  const upload = async (item: Item) => {
    patch(item.key, { status: 'uploading', error: undefined });
    try {
      const out = await fileUpload({
        filename: item.file.name || 'materyal',
        mime: item.file.type,
        request_key: item.key,
        content: { kind: 'bytes_base64', data: await toBase64(item.file) },
      });
      patch(item.key, { status: 'uploaded', fileId: out.id });
    } catch (error) {
      patch(item.key, { status: 'failed', error });
    }
  };

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    const fresh: Item[] = [];
    for (const file of Array.from(files)) {
      const limit = LIMITS[file.type];
      const url = preview(file);
      if (url) previews.current.push(url);
      fresh.push({
        key: crypto.randomUUID(),
        file,
        preview: url,
        captured: null,
        status: limit && file.size > 0 && file.size <= limit ? 'uploading' : 'refused',
      });
    }
    setItems((list) => [...list, ...fresh]);
    for (const item of fresh) {
      const captured = (await captureTime(item.file)) ?? fileTime(item.file);
      patch(item.key, { captured });
      if (!draft.starts_on && captured) {
        setDraft((d) => (d.starts_on ? d : { ...d, starts_on: m.istanbulDay(captured) }));
      }
    }
    // One at a time: a phone's connection carries one video better than three.
    for (const item of fresh) if (item.status !== 'refused') await upload(item);
  };

  // The olays the capture days suggest, nearest first (as the server answers them), then the rest.
  const list = olays.data?.map((o) => o.olay) ?? [];
  const suggested: m.Olay[] = [];
  for (const i of items) {
    if (!i.captured) continue;
    for (const o of m.olaySuggestions(list, m.istanbulDay(i.captured))) {
      if (!suggested.some((x) => x.id === o.id)) suggested.push(o);
    }
  }
  const others = list.filter((o) => !suggested.some((s) => s.id === o.id));

  const pending = items.filter((i) => i.status === 'uploaded' || i.status === 'add_failed');
  const uploading = items.some((i) => i.status === 'uploading');

  const add = useMaterialsMutation(async () => {
    let olayId: string | undefined;
    if (choice === 'new') {
      let olay = created;
      if (!olay) {
        olayKey.current ??= crypto.randomUUID();
        olay = await m.olayCreate({ ...olayInput(draft), request_key: olayKey.current });
        setCreated(olay);
      }
      olayId = olay.id;
    } else if (choice !== 'genel') {
      olayId = choice;
    }
    for (const item of pending) {
      try {
        const out = await m.materialAdd({
          request_key: `${item.key}:material`,
          file_id: item.fileId!,
          ...(olayId ? { olay_id: olayId } : { genel: true }),
          origin: { kind: 'real' },
          ...tags,
          ...(decider && permission ? { share: permission } : {}),
          ...(item.captured ? { captured_at: item.captured.toISOString() } : {}),
        });
        patch(item.key, { status: 'added', added: out, error: undefined });
      } catch (error) {
        patch(item.key, { status: 'add_failed', error });
      }
    }
  });

  const submit = () => {
    if (busy.current || add.isPending) return;
    if (!choice) return setProblem('olay');
    if (choice === 'new' && !created) {
      const p = olayDraftProblem(draft);
      if (p) return setProblem(p);
    }
    if (decider && !permission) return setProblem('permission');
    setProblem(null);
    busy.current = true;
    add.mutate(undefined, { onSettled: () => (busy.current = false) });
  };

  const reset = () => {
    setItems([]);
    setChoice(presetOlay ?? '');
    setDraft(emptyOlay());
    setPermission('');
    setTags(emptyTags());
    setCreated(null);
    olayKey.current = null;
    add.reset();
  };

  const done =
    items.some((i) => i.status === 'added') &&
    items.every((i) => i.status === 'added' || i.status === 'refused');
  const usable = items.some((i) => i.status !== 'refused');
  const addedTo = created?.id ?? (choice && choice !== 'new' && choice !== 'genel' ? choice : null);
  const olayOption = (o: m.Olay) => (
    <label
      key={o.id}
      className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 ${
        choice === o.id ? 'border-primary bg-primary/5' : 'border-border'
      }`}
    >
      <input
        type="radio"
        name="olay"
        className="mt-1"
        checked={choice === o.id}
        onChange={() => setChoice(o.id)}
      />
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{o.title}</span>
          <ProposedBadge olay={o} />
        </span>
        <OlayLine olay={o} />
      </span>
    </label>
  );

  return (
    <div className="space-y-4" data-testid="materials-upload">
      <div className="flex flex-col items-start gap-5 rounded-xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:gap-8 sm:p-8">
        {items.length === 0 && (
          <img src="/brand/scenes/studio.svg" alt="" aria-hidden="true" width={144} height={144} className="h-32 w-32 shrink-0 sm:h-36 sm:w-36" />
        )}
        <div className="min-w-0 flex-1 space-y-5">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t('materials.upload.intro')}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={primaryClass} onClick={() => camera.current?.click()}>
            <Camera aria-hidden="true" className="h-5 w-5" />
            {t('materials.upload.camera')}
          </button>
          <button type="button" className={tapClass} onClick={() => gallery.current?.click()}>
            <Upload aria-hidden="true" className="h-5 w-5" />
            {t('materials.upload.gallery')}
          </button>
        </div>
        <input
          ref={camera}
          type="file"
          accept="image/*,video/mp4"
          capture="environment"
          className="sr-only"
          aria-label={t('materials.upload.camera')}
          onChange={(e) => {
            void pick(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={gallery}
          type="file"
          accept="image/*,video/mp4"
          multiple
          className="sr-only"
          aria-label={t('materials.upload.gallery')}
          onChange={(e) => {
            void pick(e.target.files);
            e.target.value = '';
          }}
        />
        </div>
      </div>

      {items.length > 0 && (
        <ul aria-label={t('materials.upload.files')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((i) => (
            <li key={i.key} className="min-w-0 space-y-1 rounded-md border border-border p-2 text-sm">
              <MediaThumb mime={i.file.type} url={i.preview} alt={i.file.name} />
              <p className="truncate">{i.file.name}</p>
              <Badge
                tone={
                  i.status === 'added' || i.status === 'uploaded'
                    ? 'success'
                    : i.status === 'uploading'
                      ? 'neutral'
                      : 'danger'
                }
              >
                {t(`materials.upload.status.${i.status}`)}
              </Badge>
              {i.status === 'refused' && (
                <p className="text-xs text-danger">{t('materials.upload.refusedHelp')}</p>
              )}
              <MaterialsError error={i.error} />
              {i.status === 'failed' && (
                <button type="button" className={`${tapClass} w-full`} onClick={() => void upload(i)}>
                  {t('materials.upload.retry')}
                </button>
              )}
              {i.added && (
                <Suggestion out={i.added} chosen={addedTo ?? (choice === 'genel' ? 'genel' : null)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {usable && !done && (
        <form
          className={`${cardClass} space-y-5`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <fieldset className="space-y-2" aria-describedby={problem === 'olay' ? 'upload-olay-problem' : undefined}>
            <legend className="text-base font-semibold">{t('materials.upload.olay')}</legend>
            {created ? (
              <p className="text-sm">{t('materials.upload.createdOlay', { title: created.title })}</p>
            ) : (
              <>
                {suggested.length > 0 && (
                  <div className="space-y-2" role="group" aria-label={t('materials.upload.suggested')}>
                    <p className="text-sm font-medium">{t('materials.upload.suggested')}</p>
                    {suggested.map(olayOption)}
                  </div>
                )}
                {others.length > 0 && (
                  <div className="space-y-2" role="group" aria-label={t('materials.upload.otherOlays')}>
                    {suggested.length > 0 && (
                      <p className="text-sm font-medium">{t('materials.upload.otherOlays')}</p>
                    )}
                    {others.map(olayOption)}
                  </div>
                )}
                <label
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 ${
                    choice === 'new' ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <input type="radio" name="olay" checked={choice === 'new'} onChange={() => setChoice('new')} />
                  {t('materials.upload.newOlay')}
                </label>
                {choice === 'new' && (
                  <OlayFields
                    value={draft}
                    onChange={(d) => {
                      setDraft(d);
                      olayKey.current = null;
                    }}
                    occasions={calendar.data?.entries ?? []}
                  />
                )}
                {decider && (
                  <label
                    className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 ${
                      choice === 'genel' ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                  >
                    <input
                      type="radio"
                      name="olay"
                      className="mt-1"
                      checked={choice === 'genel'}
                      onChange={() => setChoice('genel')}
                    />
                    <span className="space-y-1">
                      <span className="block font-medium">{t('materials.upload.genel')}</span>
                      <span className="block text-xs text-muted-foreground">{t('materials.upload.genelHelp')}</span>
                    </span>
                  </label>
                )}
              </>
            )}
            {problem && problem !== 'permission' && (
              <p id="upload-olay-problem" role="alert" className="text-sm text-danger">
                {t(`materials.upload.problem.${problem}`)}
              </p>
            )}
            <MaterialsReadStatus query={olays} />
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-base font-semibold">{t('materials.upload.permission')}</legend>
            {!decider && <p className="text-sm text-muted-foreground">{t('materials.upload.permissionByManager')}</p>}
            {m.SHARE_PERMISSIONS.map((p) => (
              <label
                key={p}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 ${
                  permission === p ? 'border-primary bg-primary/5' : 'border-border'
                } ${decider ? '' : 'opacity-60'}`}
              >
                <input
                  type="radio"
                  name="permission"
                  value={p}
                  disabled={!decider}
                  checked={permission === p}
                  aria-invalid={problem === 'permission' || undefined}
                  onChange={() => setPermission(p)}
                />
                {t(`materials.share.${p}`)}
              </label>
            ))}
            {problem === 'permission' && (
              <p role="alert" className="text-sm text-danger">
                {t('materials.upload.problem.permission')}
              </p>
            )}
          </fieldset>

          <details className="space-y-3">
            <summary className="min-h-11 cursor-pointer py-2 text-base font-semibold">
              {t('materials.upload.tags')}
            </summary>
            <TagsFields value={tags} onChange={setTags} />
          </details>

          {uploading && <p className="text-sm text-muted-foreground">{t('materials.upload.waitUploads')}</p>}
          <button
            type="submit"
            className={`${primaryClass} w-full`}
            disabled={add.isPending || uploading || pending.length === 0}
          >
            {t('materials.upload.submit', { count: pending.length })}
          </button>
          <MaterialsError error={add.error} />
        </form>
      )}

      {done && (
        <div className={cardClass} role="status">
          <p className="font-medium">
            {t('materials.upload.done', { count: items.filter((i) => i.status === 'added').length })}
          </p>
          {!decider && <p className="text-sm">{t('materials.upload.doneNoPermission')}</p>}
          <div className="flex flex-wrap gap-2">
            {addedTo && (
              <button type="button" className={tapClass} onClick={() => onOpenOlay(addedTo)}>
                {t('materials.upload.openOlay')}
              </button>
            )}
            <button type="button" className={primaryClass} onClick={reset}>
              {t('materials.upload.again')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What the server's capture day suggests once the material is in: when its suggestions do not
 * name the olay it was added to, they show, and an owner or manager may move it there.
 */
function Suggestion({ out, chosen }: { out: m.MaterialAddOut; chosen: string | null }) {
  const { t } = useTranslation();
  const decider = useDecider();
  const [moved, setMoved] = useState<string | null>(null);
  const bind = useMaterialsMutation(
    (olay: m.Olay) =>
      m.materialBind(out.material.id, out.material.revision, { kind: 'olay', olay_id: olay.id }),
    (_, olay) => setMoved(olay.title),
  );
  if (moved) return <p className="text-xs">{t('materials.upload.moved', { title: moved })}</p>;
  if (!out.olay_suggestions.length || out.olay_suggestions.some((o) => o.id === chosen)) return null;
  return (
    <div className="space-y-1 text-xs">
      {out.olay_suggestions.slice(0, 2).map((o) => (
        <div key={o.id} className="space-y-1">
          <p>{t('materials.upload.serverSuggests', { title: o.title })}</p>
          {decider && (
            <button
              type="button"
              className={`${tapClass} w-full`}
              disabled={bind.isPending}
              onClick={() => {
                if (!bind.isPending) bind.mutate(o);
              }}
            >
              {t('materials.upload.moveThere')}
            </button>
          )}
        </div>
      ))}
      <MaterialsError error={bind.error} />
    </div>
  );
}
