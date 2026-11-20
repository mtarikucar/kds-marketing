import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Info, Loader2, Paperclip, Send, X } from 'lucide-react';
import {
  postRequest,
  type ComposerState,
  type ComposerStop,
  type PostRow,
} from '@/api/postsPage';
import { RunNowButton } from '@/components/AgentWakeLine';
import { Button, cn, IconButton, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useNeedWake, useNow, wakeTime } from '@/lib/wake';
import { ACCEPT, fileAccepted, uploadFile } from '../content/uploads';
import { materialsErrorText } from '../materials/MaterialsShared';
import { usePostsMutation } from './queries';

/** At most this many characters and files (§2.8, §3.4.1). */
export const MAX_TEXT = 2000;
export const MAX_FILES = 10;

/** A platform the owner may name in the text ("sadece TikTok"), the words that name it and its kinds. */
const NAMED: { name: string; pattern: RegExp; kinds: string[] }[] = [
  { name: 'TikTok', pattern: /(?<!\p{L})tiktok/u, kinds: ['tiktok'] },
  { name: 'Instagram', pattern: /(?<!\p{L})(instagram|insta)/u, kinds: ['instagram'] },
  { name: 'Facebook', pattern: /(?<!\p{L})(facebook|face)/u, kinds: ['facebook_page'] },
  { name: 'LinkedIn', pattern: /(?<!\p{L})linkedin/u, kinds: ['linkedin_page', 'linkedin_member'] },
  { name: 'X', pattern: /(?<!\p{L})(x|twitter)(?!\p{L})/u, kinds: ['x'] },
  { name: 'YouTube', pattern: /(?<!\p{L})youtube/u, kinds: ['youtube'] },
  { name: 'Pinterest', pattern: /(?<!\p{L})pinterest/u, kinds: ['pinterest'] },
  { name: 'Google', pattern: /(?<!\p{L})google/u, kinds: ['google_business'] },
];

/**
 * The platforms `text` names that no connected account takes (R1: said while the owner types).
 * Matched case-insensitively, with Turkish suffixes (`TikTok'ta`, `instada`), `x` and `twitter`
 * as whole words.
 */
export function unconnectedPlatforms(text: string, connected: { kind: string }[]): string[] {
  const folded = [text.toLocaleLowerCase('tr-TR'), text.toLowerCase()];
  const kinds = new Set(connected.map((c) => c.kind));
  return NAMED.filter((p) => folded.some((f) => p.pattern.test(f)) && !p.kinds.some((k) => kinds.has(k))).map((p) => p.name);
}

type Status = 'waiting' | 'uploading' | 'done' | 'failed' | 'refused';
interface Attached {
  key: string;
  file: File;
  status: Status;
  fileId?: string;
  error?: unknown;
}

/** One stop of §2.8 as a line with its action. */
function StopLine({ stop, onResume, onAccounts, canResume }: { stop: ComposerStop; onResume: () => void; onAccounts: () => void; canResume: boolean }) {
  const { t, i18n } = useTranslation();
  const wake = useNeedWake('content');
  const now = useNow(30_000);
  const at = stop.at ? wakeTime(stop.at, i18n.language) : '';
  const link = (to: string, label: string) => <Link className="font-medium text-primary underline underline-offset-4" to={to}>{label}</Link>;
  let action: React.ReactNode = null;
  switch (stop.code) {
    case 'knowledge_empty':
      action = link('/knowledge', t('postsPage.actions.toKnowledge'));
      break;
    case 'braked':
      action = canResume ? <Button size="sm" variant="outline" className="h-7" onClick={onResume}>{t('postsPage.actions.resume')}</Button> : null;
      break;
    case 'no_account':
      action = <Button size="sm" variant="outline" className="h-7" onClick={onAccounts}>{t('postsPage.actions.connect')}</Button>;
      break;
    case 'no_content_agent':
      action = link('/agents', t('postsPage.actions.connectAgent'));
      break;
    case 'agent_sleeps':
      action = link('/agents', t('postsPage.actions.addAddress'));
      break;
    case 'agent_late':
      action = wake?.state === 'schedule' && wake.run_now ? <RunNowButton run={wake.run_now} now={now} /> : null;
      break;
  }
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-[1_1_16rem]">{t(`postsPage.composer.stops.${stop.code}`, { at })}</span>
      {action}
    </li>
  );
}

/** The quiet advice line (§2.8), its parts joined by ` · `. */
function adviceLine(t: TFunction, state: ComposerState): string {
  return state.advice.map((a) => t(`postsPage.composer.advice.${a}`)).join(' · ');
}

/**
 * "Ne paylaşalım?" (design 2026-11-19 §2.8): free text and optional files, no platform picker.
 * The stops the server already knows are said under it before sending, and never block it (D20);
 * a platform named in the text that no account takes is said while typing. `Gönder` uploads the
 * files one by one and asks for the post; the new row appears first and selected.
 */
export function Composer({
  state,
  known = true,
  canResume,
  onResume,
  onAccounts,
  onCreated,
}: {
  state: ComposerState;
  /** `false` while the page's first read is out: the connected accounts are not known yet. */
  known?: boolean;
  canResume: boolean;
  onResume: () => void;
  onAccounts: () => void;
  onCreated: (row: PostRow) => void;
}) {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attached[]>([]);
  const [focused, setFocused] = useState(false);
  const [tooMany, setTooMany] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const requestKey = useRef<string | null>(null);
  const filesAllowed = state.files_allowed;

  const attach = useCallback((list: FileList | File[] | null) => {
    if (!filesAllowed || !list?.length) return;
    setFiles((current) => {
      const room = MAX_FILES - current.length;
      const fresh = Array.from(list).slice(0, Math.max(0, room)).map((file) => ({
        key: crypto.randomUUID(),
        file,
        status: (fileAccepted(file) ? 'waiting' : 'refused') as Status,
      }));
      setTooMany(list.length > room);
      return [...current, ...fresh];
    });
    requestKey.current = null;
  }, [filesAllowed]);

  // A drop anywhere on the page attaches to the composer (not to the library: that is Dosyalar).
  useEffect(() => {
    if (!filesAllowed) return;
    let depth = 0;
    const isFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (!isFiles(e)) return; e.preventDefault(); depth += 1; setDragging(true); };
    const over = (e: DragEvent) => { if (!isFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (e: DragEvent) => { if (!isFiles(e)) return; e.preventDefault(); depth = 0; setDragging(false); attach(e.dataTransfer?.files ?? null); };
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
  }, [attach, filesAllowed]);

  const patch = (key: string, change: Partial<Attached>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)));

  const send = usePostsMutation(
    async (value: { text: string; files: Attached[] }) => {
      const ids: string[] = [];
      // One at a time: a phone's connection carries one video better than three.
      for (const item of value.files) {
        if (item.status === 'refused') continue;
        if (item.fileId) { ids.push(item.fileId); continue; }
        patch(item.key, { status: 'uploading', error: undefined });
        try {
          const id = await uploadFile(item.file, item.key);
          item.fileId = id;
          patch(item.key, { status: 'done', fileId: id });
          ids.push(id);
        } catch (error) {
          patch(item.key, { status: 'failed', error });
          throw error;
        }
      }
      requestKey.current ??= crypto.randomUUID();
      return postRequest({ request_key: requestKey.current, text: value.text, file_ids: ids });
    },
    (out) => {
      setText('');
      setFiles([]);
      setTooMany(false);
      requestKey.current = null;
      const sub = out.row.sub_state;
      const description = sub?.kind === 'queued'
        ? sub.wakes_now ? t('postsPage.composer.wakesNow') : sub.next_at ? t('postsPage.composer.wakesAt', { at: wakeTime(sub.next_at, i18n.language) }) : undefined
        : undefined;
      toast.success(t('postsPage.composer.sent'), description ? { description } : undefined);
      onCreated(out.row);
    },
  );

  const trimmed = text.trim();
  const tooLong = text.length > MAX_TEXT;
  const failedUpload = files.some((f) => f.status === 'failed');
  const canSend = !!trimmed && !tooLong && !send.isPending;
  const submit = () => {
    if (!canSend) return;
    send.mutate({ text: trimmed, files });
  };
  const missing = known ? unconnectedPlatforms(text, state.connected) : [];
  const advice = (focused || text.length > 0) && state.advice.length > 0 ? adviceLine(t, state) : '';

  // The input grows to three lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * 3 + 20)}px`;
  }, [text]);

  return (
    <section aria-label={t('postsPage.composer.region')} className="min-w-0 space-y-2">
      <form
        className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-xl border border-border bg-surface p-2.5 ps-4 max-sm:flex-col max-sm:items-stretch"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <label htmlFor="posts-composer" className="text-sm font-semibold">{t('postsPage.composer.label')}</label>
        <textarea
          id="posts-composer"
          ref={area}
          rows={1}
          value={text}
          maxLength={MAX_TEXT + 200}
          placeholder={t('postsPage.composer.placeholder')}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => { setText(e.target.value); requestKey.current = null; send.reset(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="min-h-10 min-w-0 flex-[1_1_16rem] resize-none rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-2 max-sm:justify-end">
          {filesAllowed && (
            <Button type="button" variant="outline" className="border-dashed" onClick={() => input.current?.click()} aria-label={t('postsPage.composer.file')}>
              <Paperclip aria-hidden="true" className="h-4 w-4" />
              <span className="max-sm:sr-only">{t('postsPage.composer.file')}</span>
            </Button>
          )}
          <Button type="submit" disabled={!canSend} loading={send.isPending} aria-label={t('postsPage.composer.send')}>
            <Send aria-hidden="true" className="h-4 w-4 sm:hidden" />
            <span className="max-sm:sr-only">{t('postsPage.composer.send')}</span>
          </Button>
        </div>
        {filesAllowed && (
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="composer-file-input"
            onChange={(e) => { attach(e.target.files); e.target.value = ''; }}
          />
        )}
        {files.length > 0 && (
          <ul aria-label={t('postsPage.composer.files')} className="flex basis-full flex-wrap gap-1.5">
            {files.map((f) => (
              <li key={f.key} className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', f.status === 'failed' || f.status === 'refused' ? 'border-danger/50 bg-danger-subtle' : 'border-border bg-surface-muted')}>
                {f.status === 'uploading' && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                {f.status === 'done' && <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-success" />}
                <span className="max-w-[14rem] truncate">{f.file.name || t('postsPage.composer.unnamed')}</span>
                {f.status === 'uploading' && <span className="text-muted-foreground">{t('postsPage.composer.uploading')}</span>}
                {f.status === 'refused' && <span className="text-danger">{t('postsPage.composer.refused')}</span>}
                {f.status === 'failed' && (
                  <span className="text-danger" title={materialsErrorText(t, f.error)}>
                    {t('postsPage.composer.failed')} ·{' '}
                    <button type="button" className="underline" onClick={submit}>{t('postsPage.composer.retry')}</button>
                  </span>
                )}
                {f.status !== 'uploading' && (
                  <IconButton type="button" size="sm" className="h-5 w-5" aria-label={t('postsPage.composer.remove', { name: f.file.name || t('postsPage.composer.unnamed') })}
                    onClick={() => { setFiles((list) => list.filter((x) => x.key !== f.key)); requestKey.current = null; }}>
                    <X className="h-3 w-3" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </form>
      {(state.stops.length > 0 || missing.length > 0 || tooMany || tooLong || (send.error && !failedUpload)) && (
        <ul role="status" className="space-y-1.5 px-1 text-sm">
          {state.stops.map((stop) => <StopLine key={stop.code} stop={stop} canResume={canResume} onResume={onResume} onAccounts={onAccounts} />)}
          {missing.map((name) => (
            <li key={name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-[1_1_16rem]">{t('postsPage.composer.platformMissing', { platform: name })}</span>
              <Button size="sm" variant="outline" className="h-7" onClick={onAccounts}>{t('postsPage.actions.connect')}</Button>
            </li>
          ))}
          {tooMany && <li className="text-danger">{t('postsPage.composer.tooMany', { n: MAX_FILES })}</li>}
          {tooLong && <li className="text-danger">{t('postsPage.composer.tooLong', { n: MAX_TEXT })}</li>}
          {send.error != null && !failedUpload && <li role="alert" className="text-danger">{errorMessage(t, send.error)}</li>}
        </ul>
      )}
      {advice && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {advice}
        </p>
      )}
      {dragging && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50 bg-background/60 p-4">
          <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-info bg-info-subtle/80 p-4 text-center text-info">
            <Paperclip className="h-8 w-8" />
            <p className="text-xl font-medium">{t('postsPage.composer.drop')}</p>
          </div>
        </div>
      )}
    </section>
  );
}
