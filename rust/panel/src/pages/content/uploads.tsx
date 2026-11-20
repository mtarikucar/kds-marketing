import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertCircle, Loader2, Upload, X } from 'lucide-react';
import * as m from '@/api/materials';
import { fileUpload } from '@/api/studio';
import { Button, IconButton } from '@/components/ui';
import { captureTime } from '@/lib/capture';
import { useStudioKey } from '../StudioShared';
import { materialsErrorText } from '../materials/MaterialsShared';
import { placeHref } from '../posts/location';
import { POSTS_KEY } from '../posts/queries';

/** What the file store takes (`studio.file_upload`), and up to which size. */
export const LIMITS: Record<string, number> = {
  'image/jpeg': 25_000_000,
  'image/png': 25_000_000,
  'image/webp': 25_000_000,
  'image/gif': 25_000_000,
  'video/mp4': 200_000_000,
};
export const ACCEPT = Object.keys(LIMITS).join(',');

type Status = 'refused' | 'waiting' | 'uploading' | 'added' | 'failed';
interface Item {
  /** The upload's request key; the material's is derived from it, so a retry replays. */
  key: string;
  file: File;
  status: Status;
  fileId?: string;
  error?: unknown;
}

/** Whether the file store takes `file` (its type and size). */
export function fileAccepted(file: File): boolean {
  const limit = LIMITS[file.type];
  return !!limit && file.size > 0 && file.size <= limit;
}

/** Puts `file` in the file store (`studio.file_upload`) under `key`; a retry with the same key replays. */
export async function uploadFile(file: File, key: string): Promise<string> {
  const out = await fileUpload({
    filename: file.name || 'dosya',
    mime: file.type,
    request_key: key,
    content: { kind: 'bytes_base64', data: await toBase64(file) },
  });
  return out.id;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const Uploads = createContext<{ pick: () => void; add: (files: FileList | File[] | null) => void } | null>(null);

/** Opens the file picker, or adds dropped files: the page's one way in. */
export function useUploads() {
  return useContext(Uploads);
}

/**
 * The library's uploads (design 2026-11-18, the owner's rule): a button, several files at once, no
 * form, and with `dropAnywhere` a drop anywhere on the page. Every file goes in unfiled
 * (`studio.material_add` with no olay, no genel, no share permission) and waits in the analysis
 * queue; the agent's analysis describes it, labels it and files it. On Paylaşımlar a drop on the
 * page goes to the composer instead (design 2026-11-19 §2.8), so Dosyalar' `Yükle` takes none.
 */
export function UploadProvider({ enabled, dropAnywhere = true, children }: { enabled: boolean; dropAnywhere?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const studioKey = useStudioKey();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const running = useRef(false);
  const queue = useRef<Item[]>([]);
  const patch = (key: string, change: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));

  const send = useCallback(
    async (item: Item) => {
      patch(item.key, { status: 'uploading', error: undefined });
      try {
        const fileId = item.fileId ?? (await uploadFile(item.file, item.key));
        item.fileId = fileId;
        const captured = await captureTime(item.file).catch(() => null);
        await m.materialAdd({
          request_key: `${item.key}:material`,
          file_id: fileId,
          origin: { kind: 'real' },
          ...(captured ? { captured_at: captured.toISOString() } : {}),
        });
        patch(item.key, { status: 'added', fileId });
        await Promise.all([client.invalidateQueries({ queryKey: studioKey }), client.invalidateQueries({ queryKey: POSTS_KEY })]);
      } catch (error) {
        patch(item.key, { status: 'failed', error, fileId: item.fileId });
      }
    },
    [client, studioKey],
  );

  // One at a time: a phone's connection carries one video better than three.
  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) await send(queue.current.shift()!);
    running.current = false;
  }, [send]);

  const add = useCallback(
    (files: FileList | File[] | null) => {
      if (!enabled || !files?.length) return;
      const fresh: Item[] = Array.from(files).map((file) => ({
        key: crypto.randomUUID(),
        file,
        status: fileAccepted(file) ? 'waiting' : 'refused',
      }));
      setItems((list) => [...list, ...fresh]);
      queue.current.push(...fresh.filter((i) => i.status === 'waiting'));
      void drain();
    },
    [drain, enabled],
  );
  const retry = (item: Item) => {
    queue.current.push(item);
    patch(item.key, { status: 'waiting', error: undefined });
    void drain();
  };

  // The whole page takes a drop of files.
  useEffect(() => {
    if (!enabled || !dropAnywhere) return;
    let depth = 0;
    const files = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      add(e.dataTransfer?.files ?? null);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [add, enabled, dropAnywhere]);

  const busy = items.some((i) => i.status === 'waiting' || i.status === 'uploading');
  const added = items.filter((i) => i.status === 'added').length;
  return (
    <Uploads.Provider value={enabled ? { pick: () => input.current?.click(), add } : null}>
      {children}
      {enabled && (
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="content-upload-input"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      )}
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 bg-background/60 p-4"
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-info bg-info-subtle/80 p-4 text-center text-info">
            <Upload className="h-8 w-8" />
            <p className="text-xl font-medium">{t('content.upload.drop')}</p>
            <p className="text-sm text-muted-foreground">{t('content.upload.dropHelp')}</p>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <section
          aria-label={t('content.upload.tray')}
          className="fixed bottom-4 end-4 z-40 w-[min(24rem,calc(100vw-2rem))] space-y-2 rounded-lg border border-border bg-surface-raised p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <p role="status" aria-live="polite" className="text-sm font-medium">
              {busy
                ? t('content.upload.sending', { count: items.filter((i) => i.status === 'waiting' || i.status === 'uploading').length })
                : t('content.upload.sent', { count: added })}
            </p>
            {!busy && (
              <IconButton aria-label={t('kit.close')} size="sm" onClick={() => setItems([])}>
                <X className="h-4 w-4" />
              </IconButton>
            )}
          </div>
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item.key} className="flex min-w-0 items-start gap-2 text-sm">
                {item.status === 'added' ? (
                  <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : item.status === 'failed' || item.status === 'refused' ? (
                  <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                ) : (
                  <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.file.name || t('content.upload.unnamed')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {item.status === 'failed'
                      ? materialsErrorText(t, item.error)
                      : t(`content.upload.status.${item.status}`)}
                  </span>
                </span>
                {item.status === 'failed' && (
                  <Button size="sm" variant="ghost" onClick={() => retry(item)}>
                    {t('common.retry')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {added > 0 && (
            <Link className="inline-flex min-h-9 items-center text-sm text-primary underline" to={placeHref({ files: true, queue: true })}>
              {t('content.upload.openQueue')}
            </Link>
          )}
        </section>
      )}
    </Uploads.Provider>
  );
}
