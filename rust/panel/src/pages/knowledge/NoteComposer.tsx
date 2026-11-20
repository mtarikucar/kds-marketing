import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Link2, Paperclip, X } from 'lucide-react';
import { addNote, LIMITS, withdrawNote, type AgentReach, type CardOut, type NoteOut } from '@/api/knowledge';
import type { Uuid } from '@/api/types';
import { fileUpload } from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { RunNowButton } from '@/components/AgentWakeLine';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Textarea,
  toast,
} from '@/components/ui';
import { useModules } from '@/lib/modules';
import { can, isOwnerOrManager } from '@/lib/roles';
import { useNeedWake, useNow, wakeTime } from '@/lib/wake';
import { useKnowledgeMutation } from './queries';
import { knowledgeError } from './words';

/** What a note may carry (`studio.file_upload` stores it; a PDF stays knowledge, never a material). */
const NOTE_FILES: Record<string, number> = {
  'image/jpeg': 25_000_000,
  'image/png': 25_000_000,
  'image/webp': 25_000_000,
  'image/gif': 25_000_000,
  'video/mp4': 200_000_000,
  'application/pdf': 20_000_000,
};
const ACCEPT = Object.keys(NOTE_FILES).join(',');

/** How many notes are listed under the composer. */
const LISTED = 5;

interface Upload {
  key: string;
  file: File;
  state: 'uploading' | 'done' | 'failed';
  fileId?: Uuid;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Whether `url` is a link a note takes: `https://` and a host, no spaces. */
export function isHttpsLink(url: string): boolean {
  const m = /^https:\/\/([^/?#\s]+)/.exec(url.trim());
  return !!m && !/\s/.test(url.trim()) && url.trim().length <= LIMITS.link;
}

/**
 * What stands before a note is filed (R1), always said under the input from the read's
 * `notes_agent`: no agent that can file it, an agent that files it at its next run, or one that
 * is late (with "Şimdi çalıştır" where the agent can be woken). Sending stays possible.
 */
function AgentStop({ reach }: { reach: AgentReach }) {
  const { t, i18n } = useTranslation();
  const wake = useNeedWake('knowledge');
  const now = useNow(30_000);
  if (reach.state === 'ok') return null;
  const time = reach.next_at ? wakeTime(reach.next_at, i18n.language) : null;
  const run = wake?.state === 'schedule' ? wake.run_now : null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {reach.state === 'none' && (
        <>
          {t('knowledge.composer.stops.none')}{' '}
          <Link className="font-medium text-primary underline underline-offset-4" to="/agents">{t('knowledge.composer.stops.connect')}</Link>
        </>
      )}
      {reach.state === 'asleep' && (time ? t('knowledge.composer.stops.asleep', { time }) : t('knowledge.composer.stops.asleepUnknown'))}
      {reach.state === 'late' && (
        <>
          {time ? t('knowledge.composer.stops.late', { time }) : t('knowledge.composer.stops.lateUnknown')}
          {run && <RunNowButton run={run} now={now} />}
        </>
      )}
    </p>
  );
}

/** One note under the composer: its text cut short, then where it stands or what became of it. */
function NoteRow({ note, cards, canWithdraw }: { note: NoteOut; cards: CardOut[]; canWithdraw: boolean }) {
  const { t } = useTranslation();
  const withdraw = useKnowledgeMutation((n: NoteOut) => withdrawNote(n.id, { expected_revision: n.revision }));
  const outcome = note.outcome ?? {};
  const lines: { key: string; text: string; link?: { to: string; label: string } }[] = [];
  if (note.status === 'filed') {
    const titles = (outcome.cards ?? []).map((c) => cards.find((card) => card.id === c.card_id)?.title ?? t('knowledge.notes.aCard'));
    if (titles.length) {
      const card = titles.join(', ');
      const summary = outcome.summary?.trim();
      const key = titles.length > 1 ? 'cards' : 'card';
      lines.push({ key: 'cards', text: summary ? t(`knowledge.notes.${key}`, { card, summary }) : t(`knowledge.notes.${key}Plain`, { card }) });
    }
    for (const [i, line] of (outcome.rules ?? []).entries()) lines.push({ key: `rule-${i}`, text: t('knowledge.notes.rule', { line }), link: { to: '#kurallar', label: t('knowledge.rules.title') } });
    for (const [i, line] of (outcome.goals ?? []).entries()) lines.push({ key: `goal-${i}`, text: t('knowledge.notes.goal', { line }), link: { to: '#hedefler', label: t('knowledge.goals.title') } });
    if (outcome.post_request) lines.push({ key: 'post', text: t('knowledge.notes.post'), link: { to: `/posts?content=${encodeURIComponent(outcome.post_request.area_id)}`, label: t('knowledge.notes.postLink') } });
    if (outcome.proposals?.length) lines.push({ key: 'proposals', text: t('knowledge.notes.proposals'), link: { to: '#oneriler', label: t('knowledge.proposals.title') } });
    if (!lines.length) lines.push({ key: 'filed', text: outcome.summary?.trim() || t('knowledge.notes.filed') });
  }
  if (note.status === 'dismissed') lines.push({ key: 'dismissed', text: outcome.dismissed?.trim() ? t('knowledge.notes.dismissed', { reason: outcome.dismissed.trim() }) : t('knowledge.notes.dismissedPlain') });
  if (note.status === 'withdrawn') lines.push({ key: 'withdrawn', text: t('knowledge.notes.withdrawn') });
  return (
    <li className="flex min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0">
      <p className="truncate text-sm" title={note.text}>{note.text}</p>
      {note.status === 'open' ? (
        <p className="flex flex-wrap items-center gap-x-3 text-caption text-muted-foreground">
          <span>{t('knowledge.notes.waiting')}</span>
          {canWithdraw && (
            <button type="button" className="font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50" disabled={withdraw.isPending} onClick={() => withdraw.mutate(note)}>
              {t('knowledge.notes.withdraw')}
            </button>
          )}
        </p>
      ) : (
        lines.map((line) => (
          <p key={line.key} className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
            {line.text}
            {line.link && (
              <>
                {' · '}
                {line.link.to.startsWith('#') ? (
                  <a className="font-medium text-primary underline-offset-4 hover:underline" href={line.link.to}>{line.link.label}</a>
                ) : (
                  <Link className="font-medium text-primary underline-offset-4 hover:underline" to={line.link.to}>{line.link.label}</Link>
                )}
              </>
            )}
          </p>
        ))
      )}
      {withdraw.error && <p role="alert" className="text-caption text-danger">{knowledgeError(t, withdraw.error)}</p>}
    </li>
  );
}

/** The notes under the composer: every open one, then the newest closed, five at most in all. */
export function listedNotes(notes: NoteOut[]): NoteOut[] {
  const newest = [...notes].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const open = newest.filter((n) => n.status === 'open');
  return [...open, ...newest.filter((n) => n.status !== 'open').slice(0, Math.max(0, LISTED - open.length))];
}

/**
 * "Ajanlara bir şey anlat" (§4.11.2): one line (it grows), a file or a link, "Ekle". What stands
 * before the note is filed is said under the input before sending; then the last notes and
 * what the agent did with each.
 */
export function NoteComposer({ reach, notes, cards, editable }: { reach: AgentReach; notes: NoteOut[]; cards: CardOut[]; editable: boolean }) {
  const { t } = useTranslation();
  const session = useSession();
  const modules = useModules();
  const libraryInstalled = !!modules.data?.modules.find((m) => m.blueprint.id === 'materials')?.installed;
  const filesAllowed = libraryInstalled && can(session.data, 'materials.work');
  const [text, setText] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const picker = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const me = session.data?.user_id;
  const manager = isOwnerOrManager(session.data);

  const send = useKnowledgeMutation(addNote, () => {
    // With a stop said under the input, the note waits for the agent: the answer says so (§4.11).
    toast.success(reach.state === 'ok' ? t('knowledge.composer.sent') : t('knowledge.composer.sentNoAgent'));
    setText('');
    setLinks([]);
    setUploads([]);
    setLinkDraft(null);
    requestKey.current = crypto.randomUUID();
  });

  const upload = async (item: Upload) => {
    setUploads((list) => list.map((u) => (u.key === item.key ? { ...u, state: 'uploading' } : u)));
    try {
      const out = await fileUpload({ filename: item.file.name || 'dosya', mime: item.file.type, request_key: item.key, content: { kind: 'bytes_base64', data: await toBase64(item.file) } });
      setUploads((list) => list.map((u) => (u.key === item.key ? { ...u, state: 'done', fileId: out.id } : u)));
    } catch {
      setUploads((list) => list.map((u) => (u.key === item.key ? { ...u, state: 'failed' } : u)));
    }
  };

  const addFiles = (files: FileList | null) => {
    setRefused(null);
    if (!files?.length) return;
    const fresh: Upload[] = [];
    for (const file of Array.from(files)) {
      const max = NOTE_FILES[file.type];
      if (!max || file.size > max) {
        setRefused(t('knowledge.composer.fileRefused', { name: file.name }));
        continue;
      }
      if (uploads.length + fresh.length >= LIMITS.noteFiles) {
        setRefused(t('knowledge.composer.tooMany'));
        break;
      }
      fresh.push({ key: crypto.randomUUID(), file, state: 'uploading' });
    }
    setUploads((list) => [...list, ...fresh]);
    for (const item of fresh) void upload(item);
  };

  const addLink = () => {
    const url = (linkDraft ?? '').trim();
    if (!isHttpsLink(url)) {
      setLinkError(true);
      return;
    }
    setLinkError(false);
    if (links.length >= LIMITS.noteLinks) {
      setRefused(t('knowledge.composer.tooMany'));
      return;
    }
    if (!links.includes(url)) setLinks([...links, url]);
    setLinkDraft(null);
  };

  const pending = uploads.some((u) => u.state !== 'done');
  const ready = text.trim().length > 0 && !pending && !send.isPending;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    send.mutate({
      request_key: requestKey.current,
      text: text.trim(),
      ...(links.length ? { links } : {}),
      ...(uploads.length ? { file_ids: uploads.flatMap((u) => (u.fileId ? [u.fileId] : [])) } : {}),
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const listed = listedNotes(notes);
  if (!editable && listed.length === 0) return null;

  return (
    <section aria-labelledby="knowledge-note-label" className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-3 sm:px-4">
      {editable && (
        <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <label id="knowledge-note-label" htmlFor="knowledge-note" className="text-sm font-semibold sm:ps-1">
              {t('knowledge.composer.label')}
            </label>
            <Textarea
              id="knowledge-note"
              rows={1}
              value={text}
              maxLength={LIMITS.noteText}
              placeholder={t('knowledge.composer.placeholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              className="min-h-10 flex-[1_1_16rem] resize-none py-2 [field-sizing:content] sm:max-h-40"
            />
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" className="border-dashed">
                    <Paperclip className="h-4 w-4" aria-hidden="true" />
                    {t('knowledge.composer.attach')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-w-xs">
                  {filesAllowed && <DropdownMenuItem onSelect={() => picker.current?.click()}>{t('knowledge.composer.addFile')}</DropdownMenuItem>}
                  <DropdownMenuItem
                    onSelect={() => {
                      setLinkDraft('');
                      setLinkError(false);
                      setTimeout(() => linkInput.current?.focus(), 0);
                    }}
                  >
                    {t('knowledge.composer.addLink')}
                  </DropdownMenuItem>
                  {!libraryInstalled && <DropdownMenuLabel className="whitespace-normal text-caption font-normal text-muted-foreground">{t('knowledge.composer.noFiles')}</DropdownMenuLabel>}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="submit" disabled={!ready} loading={send.isPending}>
                {t('knowledge.composer.send')}
              </Button>
            </div>
          </div>
          <input ref={picker} type="file" multiple accept={ACCEPT} className="hidden" data-testid="knowledge-note-files" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          {linkDraft !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                ref={linkInput}
                type="url"
                inputMode="url"
                aria-label={t('knowledge.composer.linkLabel')}
                placeholder="https://"
                value={linkDraft}
                aria-invalid={linkError || undefined}
                onChange={(e) => setLinkDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addLink();
                  }
                }}
                className="flex-[1_1_16rem]"
              />
              <Button type="button" variant="outline" size="sm" onClick={addLink}>{t('knowledge.composer.linkAdd')}</Button>
              <IconButton variant="ghost" size="sm" aria-label={t('knowledge.cancel')} onClick={() => setLinkDraft(null)}>
                <X className="h-4 w-4" />
              </IconButton>
              {linkError && <p role="alert" className="w-full text-caption text-danger">{t('knowledge.composer.linkInvalid')}</p>}
            </div>
          )}
          {(links.length > 0 || uploads.length > 0) && (
            <ul className="flex flex-wrap gap-2" aria-label={t('knowledge.composer.attached')}>
              {links.map((url) => (
                <li key={url} className="flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-muted py-0.5 pe-1 ps-2.5 text-caption">
                  <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{url}</span>
                  <IconButton variant="ghost" size="sm" className="h-6 w-6" aria-label={t('knowledge.composer.remove', { name: url })} onClick={() => setLinks(links.filter((l) => l !== url))}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
              {uploads.map((u) => (
                <li key={u.key} className="flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-muted py-0.5 pe-1 ps-2.5 text-caption">
                  <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{u.file.name}</span>
                  {u.state === 'uploading' && <span role="status" className="text-muted-foreground">{t('knowledge.composer.uploading')}</span>}
                  {u.state === 'failed' && (
                    <button type="button" className="font-medium text-danger underline-offset-4 hover:underline" onClick={() => void upload(u)}>
                      {t('knowledge.composer.uploadFailed')}
                    </button>
                  )}
                  <IconButton variant="ghost" size="sm" className="h-6 w-6" aria-label={t('knowledge.composer.remove', { name: u.file.name })} onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}>
                    <X className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          {refused && <p role="alert" className="text-caption text-danger">{refused}</p>}
          {send.error && <p role="alert" className="text-sm text-danger">{knowledgeError(t, send.error)}</p>}
          <AgentStop reach={reach} />
        </form>
      )}
      {!editable && <h2 id="knowledge-note-label" className="text-sm font-semibold">{t('knowledge.notes.title')}</h2>}
      {listed.length > 0 && (
        <ul aria-label={t('knowledge.notes.title')} className="flex flex-col">
          {listed.map((note) => (
            <NoteRow key={note.id} note={note} cards={cards} canWithdraw={editable && (note.created_by === me || manager)} />
          ))}
        </ul>
      )}
    </section>
  );
}
