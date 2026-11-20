import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FileText, Link2, Paperclip, Plus, Search, X } from 'lucide-react';
import {
  archiveCard,
  cardHistory,
  createCard,
  LIMITS,
  updateCard,
  type AttachmentInput,
  type CardOut,
  type KnowledgeAttachment,
  type RevisionOut,
  type StoredCard,
} from '@/api/knowledge';
import { fileUpload } from '@/api/studio';
import { listTeam } from '@/api/team';
import type { MemberOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import {
  Badge,
  Button,
  ConfirmDialog,
  IconButton,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Textarea,
  cn,
  toast,
} from '@/components/ui';
import { formatWhen } from '@/lib/format';
import { useModules } from '@/lib/modules';
import { can } from '@/lib/roles';
import { isHttpsLink } from './NoteComposer';
import { isStale, useKnowledgeMutation } from './queries';
import { knowledgeError } from './words';

/** The seed cards' keys whose placeholder the page shows while their text is empty (§4.11). */
const PLACEHOLDER_KEYS = ['who_we_are', 'products_prices', 'voice', 'customers', 'post_ideas', 'who_we_seek', 'accounts_channels', 'references'] as const;
type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];
const isPlaceholderKey = (key: string | null): key is PlaceholderKey => !!key && (PLACEHOLDER_KEYS as readonly string[]).includes(key);

/** A card an agent filed into within this long reads "Yeni". */
const NEW_FOR_MS = 24 * 3600 * 1000;
/** How long "Geri al" is offered after a card is removed. */
export const UNDO_MS = 10_000;

/** What a file attachment may be: an image, an MP4 or a PDF (knowledge, never a material). */
const CARD_FILES: Record<string, number> = {
  'image/jpeg': 25_000_000,
  'image/png': 25_000_000,
  'image/webp': 25_000_000,
  'image/gif': 25_000_000,
  'video/mp4': 200_000_000,
  'application/pdf': 20_000_000,
};

/** A narrow screen, where an editor is a full-screen sheet rather than in place. */
function useIsPhone(): boolean {
  const query = '(max-width: 639px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const on = () => setPhone(media.matches);
    media.addEventListener?.('change', on);
    return () => media.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** The placeholder of a card's text: a seed card's own question, else a general one. */
function placeholderOf(t: TFunction, key: string | null): string {
  return isPlaceholderKey(key) ? t(`knowledge.cards.placeholders.${key}`) : t('knowledge.cards.placeholders.own');
}

/** Whether `card` matches the search (title or body, case- and accent-tolerant as Turkish reads it). */
export function cardMatches(card: Pick<CardOut, 'title' | 'body'>, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('tr');
  if (!q) return true;
  return `${card.title}\n${card.body}`.toLocaleLowerCase('tr').includes(q);
}

function AttachmentChip({ attachment, onRemove }: { attachment: KnowledgeAttachment; onRemove?: () => void }) {
  const { t } = useTranslation();
  const label = attachment.kind === 'link' ? attachment.title || attachment.url : attachment.name || t('knowledge.cards.file');
  const href = attachment.kind === 'link' ? attachment.url : attachment.url ?? null;
  const Icon = attachment.kind === 'link' ? Link2 : attachment.mime === 'application/pdf' ? FileText : Paperclip;
  return (
    <li className="flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-muted py-0.5 pe-1 ps-2.5 text-caption">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {href ? (
        <a className="truncate underline-offset-4 hover:underline" href={href} target="_blank" rel="noreferrer noopener">{label}</a>
      ) : (
        <span className="truncate">{label}</span>
      )}
      {onRemove ? (
        <IconButton variant="ghost" size="sm" className="h-6 w-6" aria-label={t('knowledge.cards.removeAttachment', { name: label })} onClick={onRemove}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      ) : (
        <span className="pe-1.5" />
      )}
    </li>
  );
}

const asInput = (a: KnowledgeAttachment): AttachmentInput =>
  a.kind === 'link' ? { kind: 'link', url: a.url, ...(a.title ? { title: a.title } : {}) } : { kind: 'file', file_id: a.file_id };
const sameAttachments = (a: KnowledgeAttachment[], b: KnowledgeAttachment[]) => JSON.stringify(a.map(asInput)) === JSON.stringify(b.map(asInput));

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * A card being written: title, text, attachments, "Kaydet" / "Vazgeç", and in a quiet row
 * "Geçmiş" and "Kaldır". `card` is `null` for a new card. The editor writes over the card as it
 * was when opened (the page reads again on its own meanwhile): a newer card replaces an untouched
 * editor's fields, and a stale save shows the card as it now is, under the sentence that says so.
 * `removeError`: why "Kaldır" was refused, said here where the owner is.
 */
function CardEditor({
  card,
  onClose,
  onHistory,
  onRemove,
  removeError,
  autoFocus,
}: {
  card: CardOut | null;
  onClose: () => void;
  onHistory: () => void;
  onRemove: () => void;
  removeError: unknown;
  autoFocus: boolean;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const modules = useModules();
  const filesAllowed = !!modules.data?.modules.find((m) => m.blueprint.id === 'materials')?.installed && can(session.data, 'materials.work');
  const [base, setBase] = useState(card);
  const [reload, setReload] = useState(false);
  const [title, setTitle] = useState(card?.title ?? '');
  const [body, setBody] = useState(card?.body ?? '');
  const [attachments, setAttachments] = useState<KnowledgeAttachment[]>(card?.attachments ?? []);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const save = useKnowledgeMutation(
    (input: { title: string; body: string; attachments: KnowledgeAttachment[] }) => {
      if (!base) return createCard({ title: input.title, body: input.body, attachments: input.attachments.map(asInput) });
      return updateCard(base.id, {
        expected_revision: base.revision,
        ...(input.title !== base.title ? { title: input.title } : {}),
        ...(input.body !== base.body ? { body: input.body } : {}),
        ...(!sameAttachments(input.attachments, base.attachments) ? { attachments: input.attachments.map(asInput) } : {}),
      });
    },
    () => {
      toast.success(t('knowledge.saved'));
      onClose();
    },
    (err) => {
      if (isStale(err)) setReload(true);
    },
  );

  useEffect(() => {
    if (!autoFocus) return;
    (card ? bodyRef : titleRef).current?.focus();
  }, []);

  // A newer card: taken in while nothing was changed here, or after a stale save or removal
  // (under the sentence that says so). Edits in progress are otherwise kept until they are saved.
  const staleRemoval = useRef<unknown>(null);
  const wanted = reload || (isStale(removeError) && staleRemoval.current !== removeError);
  useEffect(() => {
    if (!card || !base) return;
    if (card.revision === base.revision) {
      // A refused removal is told once the page read again: the card here is already the latest.
      staleRemoval.current = removeError;
      return;
    }
    const untouched = title === base.title && body === base.body && sameAttachments(attachments, base.attachments);
    if (!untouched && !wanted) return;
    setBase(card);
    setTitle(card.title);
    setBody(card.body);
    setAttachments(card.attachments);
    setReload(false);
    staleRemoval.current = removeError;
  }, [card?.revision, wanted]);

  const addFiles = async (files: FileList | null) => {
    setProblem(null);
    for (const file of Array.from(files ?? [])) {
      const max = CARD_FILES[file.type];
      if (!max || file.size > max) {
        setProblem(t('knowledge.composer.fileRefused', { name: file.name }));
        continue;
      }
      if (attachments.length >= LIMITS.attachments) {
        setProblem(t('knowledge.cards.tooManyAttachments'));
        break;
      }
      setUploading((n) => n + 1);
      try {
        const out = await fileUpload({ filename: file.name || 'dosya', mime: file.type, request_key: crypto.randomUUID(), content: { kind: 'bytes_base64', data: await toBase64(file) } });
        setAttachments((list) => [...list, { kind: 'file', file_id: out.id, name: file.name, mime: file.type }]);
      } catch {
        setProblem(t('knowledge.composer.uploadFailedNamed', { name: file.name }));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const addLink = () => {
    const url = (linkDraft ?? '').trim();
    if (!isHttpsLink(url)) {
      setProblem(t('knowledge.composer.linkInvalid'));
      return;
    }
    if (attachments.length >= LIMITS.attachments) {
      setProblem(t('knowledge.cards.tooManyAttachments'));
      return;
    }
    setProblem(null);
    setAttachments((list) => [...list, { kind: 'link', url }]);
    setLinkDraft(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setProblem(t('knowledge.cards.titleRequired'));
      titleRef.current?.focus();
      return;
    }
    setProblem(null);
    save.mutate({ title: title.trim(), body: body.trim(), attachments });
  };
  const changed = !base || title.trim() !== base.title || body.trim() !== base.body || !sameAttachments(attachments, base.attachments);
  const label = card ? t('knowledge.cards.editLabel', { title: card.title }) : t('knowledge.cards.newCard');

  return (
    <form aria-label={label} className="flex flex-col gap-3" onSubmit={submit} noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="knowledge-card-title" className="text-caption text-muted-foreground">{t('knowledge.cards.titleField')}</label>
        <Input id="knowledge-card-title" ref={titleRef} value={title} maxLength={LIMITS.cardTitle} onChange={(e) => setTitle(e.target.value)} className="font-semibold" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="knowledge-card-body" className="text-caption text-muted-foreground">{t('knowledge.cards.bodyField')}</label>
        <Textarea
          id="knowledge-card-body"
          ref={bodyRef}
          rows={6}
          value={body}
          maxLength={LIMITS.cardBody}
          placeholder={placeholderOf(t, card?.key ?? null)}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-32 [field-sizing:content]"
        />
      </div>
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('knowledge.cards.attachments')}>
          {attachments.map((a, i) => (
            <AttachmentChip key={`${a.kind}-${a.kind === 'link' ? a.url : a.file_id}-${i}`} attachment={a} onRemove={() => setAttachments((list) => list.filter((_, j) => j !== i))} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {linkDraft === null ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setLinkDraft('')}>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {t('knowledge.composer.addLink')}
          </Button>
        ) : (
          <>
            <Input
              type="url"
              inputMode="url"
              autoFocus
              aria-label={t('knowledge.composer.linkLabel')}
              placeholder="https://"
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addLink();
                }
              }}
              className="flex-[1_1_14rem]"
            />
            <Button type="button" variant="outline" size="sm" onClick={addLink}>{t('knowledge.composer.linkAdd')}</Button>
          </>
        )}
        {filesAllowed && (
          <>
            <Button type="button" variant="ghost" size="sm" loading={uploading > 0} onClick={() => picker.current?.click()}>
              <Paperclip className="h-4 w-4" aria-hidden="true" />
              {t('knowledge.composer.addFile')}
            </Button>
            <input ref={picker} type="file" multiple accept={Object.keys(CARD_FILES).join(',')} className="hidden" data-testid="knowledge-card-files" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          </>
        )}
      </div>
      {problem && <p role="alert" className="text-caption text-danger">{problem}</p>}
      {save.error && <p role="alert" className="text-sm text-danger">{knowledgeError(t, save.error)}</p>}
      {!!removeError && <p role="alert" className="text-sm text-danger">{knowledgeError(t, removeError)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={save.isPending} disabled={!changed || uploading > 0}>{t('knowledge.save')}</Button>
        <Button type="button" variant="outline" onClick={onClose}>{t('knowledge.cancel')}</Button>
        {card && (
          <span className="ms-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onHistory}>{t('knowledge.cards.history')}</Button>
            <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={onRemove}>{t('knowledge.cards.remove')}</Button>
          </span>
        )}
      </div>
    </form>
  );
}

/** A member's name as the team list gives it: the display name, else the email. */
export function memberNames(team: readonly MemberOut[] | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of team ?? []) {
    const name = m.display_name?.trim() || m.email;
    if (m.user_id && name) names.set(m.user_id, name);
  }
  return names;
}

/**
 * Who and why of one revision, in the owner's words ("Sen", a name, "Ajan (not)", …). A revision
 * names its person by id only: `names` (the team list) gives the name.
 */
export function revisionWho(t: TFunction, rev: RevisionOut, me: string | undefined, names?: ReadonlyMap<string, string>): string {
  const person =
    rev.by.kind === 'human' ? (rev.by.user_id === me ? t('knowledge.history.you') : names?.get(rev.by.user_id) || t('knowledge.history.member')) : null;
  switch (rev.cause) {
    case 'note':
      return t('knowledge.history.note');
    case 'proposal':
      return person ? `${person} · ${t('knowledge.history.proposal')}` : t('knowledge.history.proposal');
    case 'seed':
    case 'backfill':
      return t('knowledge.history.seed');
    case 'resync':
      return t('knowledge.history.resync');
    case 'system':
      return t('knowledge.history.system');
    case 'owner':
    default:
      return person ?? (rev.by.kind === 'agent' ? t('knowledge.history.agent') : t('knowledge.history.system'));
  }
}

/** "Geçmiş": every revision of a card, newest first, each with "Bu hâline dön" for who may change it. */
function HistorySheet({ card, editable, onClose }: { card: CardOut | undefined; editable: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const history = useInfiniteQuery({
    queryKey: ['knowledge', 'history', card?.id],
    queryFn: ({ pageParam }) => cardHistory(card!.id, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
    enabled: !!card,
  });
  // The people a revision names (by id): the team list, read once the sheet opens.
  const team = useQuery({ queryKey: ['knowledge', 'team', session.data?.current_workspace], queryFn: listTeam, enabled: !!card, retry: false, staleTime: 5 * 60_000 });
  const names = useMemo(() => memberNames(team.data), [team.data]);
  const restore = useKnowledgeMutation(
    (rev: RevisionOut) =>
      updateCard(card!.id, {
        expected_revision: card!.revision,
        title: rev.content.title ?? card!.title,
        body: rev.content.body ?? '',
        attachments: (rev.content.attachments ?? []).map(asInput),
      }),
    () => {
      toast.success(t('knowledge.history.restored'));
      onClose();
    },
  );
  const revisions = history.data?.pages.flatMap((p) => p.revisions) ?? [];
  return (
    <Sheet open={!!card} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-md overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('knowledge.history.title')}</SheetTitle>
          <SheetDescription>{card ? card.title : ''}</SheetDescription>
        </SheetHeader>
        {history.isLoading && <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>}
        {history.isError && (
          <p role="alert" className="text-sm text-danger">
            {knowledgeError(t, history.error)}{' '}
            <button type="button" className="underline" onClick={() => void history.refetch()}>{t('common.retry')}</button>
          </p>
        )}
        {history.isSuccess && revisions.length === 0 && <p className="text-sm text-muted-foreground">{t('knowledge.history.empty')}</p>}
        <ol className="flex flex-col gap-3">
          {revisions.map((rev) => {
            const current = card && rev.revision === card.revision;
            return (
              <li key={rev.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                <p className="text-caption text-muted-foreground">
                  {formatWhen(rev.at, i18n.language)} · {revisionWho(t, rev, session.data?.user_id, names)}
                  {rev.content.archived && <> · {t('knowledge.history.removedState')}</>}
                </p>
                {rev.content.title && <p className="text-sm font-semibold [overflow-wrap:anywhere]">{rev.content.title}</p>}
                <p className="line-clamp-6 whitespace-pre-line text-sm [overflow-wrap:anywhere]">{rev.content.body || '—'}</p>
                {editable && !current && (
                  <Button size="sm" variant="outline" className="self-start" loading={restore.isPending && restore.variables?.id === rev.id} onClick={() => restore.mutate(rev)}>
                    {t('knowledge.history.restore')}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
        {restore.error && <p role="alert" className="text-sm text-danger">{knowledgeError(t, restore.error)}</p>}
        {history.hasNextPage && (
          <Button variant="outline" className="self-center" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            {t('knowledge.history.more')}
          </Button>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * One card as read: its title, its text cut to four lines, its attachments, "Yeni" after an agent
 * filed. For an editor the title is a button inside the heading that covers the whole card (its
 * text describes it), so the heading and the text read as they are.
 */
function CardView({ card, editable, onOpen, now }: { card: CardOut; editable: boolean; onOpen: () => void; now: number }) {
  const { t } = useTranslation();
  const fresh = card.filed && now - Date.parse(card.filed.at) < NEW_FOR_MS;
  const bodyId = `card-body-${card.id}`;
  return (
    <article className="relative flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-4 transition-colors focus-within:border-primary hover:border-border-strong">
      {fresh && card.filed && (
        <span className="group absolute end-3 top-3 z-10">
          <Badge tone="primary" size="sm" tabIndex={0} aria-describedby={`filed-${card.id}`}>{t('knowledge.cards.newBadge')}</Badge>
          <span id={`filed-${card.id}`} role="tooltip" className="pointer-events-none invisible absolute end-0 top-full z-20 mt-1 w-56 rounded-md bg-foreground px-2.5 py-1.5 text-caption text-background shadow-md group-focus-within:visible group-hover:visible">
            {card.filed.summary?.trim() ? t('knowledge.cards.filed', { summary: card.filed.summary.trim() }) : t('knowledge.cards.filedPlain')}
          </span>
        </span>
      )}
      <h3 className={cn('min-w-0 text-base font-semibold [overflow-wrap:anywhere]', fresh && 'pe-12')}>
        {editable ? (
          <button
            type="button"
            className="text-start after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
            aria-describedby={bodyId}
            onClick={onOpen}
          >
            {card.title}
          </button>
        ) : (
          card.title
        )}
      </h3>
      {card.body.trim() ? (
        <p id={bodyId} className="line-clamp-4 whitespace-pre-line text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{card.body}</p>
      ) : (
        <p id={bodyId} className="text-sm italic text-muted-foreground">{placeholderOf(t, card.key)}</p>
      )}
      {card.attachments.length > 0 && (
        <ul className="relative z-10 flex flex-wrap gap-1.5" aria-label={t('knowledge.cards.attachments')}>
          {card.attachments.map((a, i) => <AttachmentChip key={i} attachment={a} />)}
        </ul>
      )}
    </article>
  );
}

/**
 * "Ajanların bildikleri" (§4.11.4): a search, a grid of cards and "+ Yeni kart". A card opens in
 * place as an editor (a full-screen sheet on a phone); `openId` is the card in the address
 * (`card=`), `'new'` for a new one. Removing a card offers "Geri al" for ten seconds.
 */
export function Cards({
  cards,
  editable,
  openId,
  onOpen,
  historyId,
  onHistory,
}: {
  cards: CardOut[];
  editable: boolean;
  openId: string | null;
  onOpen: (id: string | null) => void;
  historyId: string | null;
  onHistory: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const [query, setQuery] = useState('');
  const [removing, setRemoving] = useState<CardOut | null>(null);
  // The card as the removal answered it: "Geri al" restores it at that revision.
  const [undo, setUndo] = useState<Pick<StoredCard, 'id' | 'revision' | 'title'> | null>(null);
  const [now] = useState(() => Date.now());
  const shown = useMemo(() => cards.filter((c) => cardMatches(c, query) || c.id === openId), [cards, query, openId]);
  const open = openId && openId !== 'new' ? cards.find((c) => c.id === openId) : undefined;
  const creating = openId === 'new' && editable;

  const removedHere = useRef<string | null>(null);
  const remove = useKnowledgeMutation(
    (card: CardOut) => archiveCard(card.id, { expected_revision: card.revision, archived: true }),
    (out) => {
      removedHere.current = out.id;
      setRemoving(null);
      onOpen(null);
      setUndo(out);
    },
    // The question closes, so the refusal (said in the editor) and the card as it now is show.
    () => setRemoving(null),
  );
  const restore = useKnowledgeMutation((card: Pick<StoredCard, 'id' | 'revision'>) => archiveCard(card.id, { expected_revision: card.revision, archived: false }), () => {
    removedHere.current = null;
    setUndo(null);
  });
  // A card in the address that the read no longer holds (removed meanwhile, or never there):
  // its editor and history close, and the owner is told, unless the removal was made here.
  useEffect(() => {
    const gone = (id: string | null) => !!id && id !== 'new' && !cards.some((c) => c.id === id);
    // One address change at a time: the history closes on the next pass.
    if (gone(openId)) {
      if (openId !== removedHere.current) toast.warning(t('knowledge.cards.archived'), { id: `knowledge-card-gone-${openId}` });
      onOpen(null);
    } else if (gone(historyId)) {
      onHistory(null);
    }
  }, [cards, openId, historyId]);

  useEffect(() => {
    if (!undo) return;
    const id = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(id);
  }, [undo]);

  const editor = (card: CardOut | null) => (
    <CardEditor
      key={card?.id ?? 'new'}
      card={card}
      autoFocus
      removeError={card && remove.variables?.id === card.id ? remove.error : null}
      onClose={() => {
        remove.reset();
        onOpen(null);
      }}
      onHistory={() => card && onHistory(card.id)}
      onRemove={() => {
        if (!card) return;
        remove.reset();
        setRemoving(card);
      }}
    />
  );
  const sheet = phone && editable && (open || creating);

  return (
    <section aria-labelledby="knowledge-cards" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="knowledge-cards" className="flex-1 text-base font-semibold">{t('knowledge.cards.title')}</h2>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" aria-label={t('knowledge.cards.searchLabel')} placeholder={t('knowledge.cards.search')} value={query} onChange={(e) => setQuery(e.target.value)} className="ps-8" />
        </div>
      </div>
      {undo && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
          {t('knowledge.cards.removed', { title: undo.title })}
          <Button size="sm" variant="outline" loading={restore.isPending} onClick={() => restore.mutate(undo)}>{t('knowledge.cards.undo')}</Button>
          {restore.error && <span role="alert" className="text-danger">{knowledgeError(t, restore.error)}</span>}
        </p>
      )}
      {shown.length === 0 && query.trim() && <p className="text-sm text-muted-foreground">{t('knowledge.cards.noMatch')}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {shown.map((card) =>
          !phone && editable && card.id === openId ? (
            <div key={card.id} className="col-span-full rounded-xl border border-primary bg-surface p-4">{editor(card)}</div>
          ) : (
            <CardView key={card.id} card={card} editable={editable} now={now} onOpen={() => onOpen(card.id)} />
          ),
        )}
        {creating && !phone && <div className="col-span-full rounded-xl border border-primary bg-surface p-4">{editor(null)}</div>}
        {editable && !creating && (
          <button
            type="button"
            className={cn('flex min-h-28 items-center justify-center gap-1.5 rounded-xl border-[1.5px] border-dashed border-border-strong p-4 text-sm text-muted-foreground hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
            onClick={() => onOpen('new')}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('knowledge.cards.new')}
          </button>
        )}
      </div>
      {sheet && (
        <Sheet open onOpenChange={(o) => !o && onOpen(null)}>
          <SheetContent side="bottom" className="h-dvh max-h-dvh w-full" aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle>{open ? open.title : t('knowledge.cards.newCard')}</SheetTitle>
            </SheetHeader>
            {editor(open ?? null)}
          </SheetContent>
        </Sheet>
      )}
      {editable && (
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(o) => !o && setRemoving(null)}
          title={t('knowledge.cards.removeTitle')}
          confirmLabel={t('knowledge.cards.remove')}
          cancelLabel={t('knowledge.cancel')}
          tone="danger"
          loading={remove.isPending}
          // The card as the page now holds it: pressed again after a refusal, at its latest revision.
          onConfirm={() => removing && remove.mutate(cards.find((c) => c.id === removing.id) ?? removing)}
        />
      )}
      {/* A card's history is its editors' (`strategy.card_history` needs `team.manage`). */}
      <HistorySheet card={editable && historyId ? cards.find((c) => c.id === historyId) : undefined} editable={editable} onClose={() => onHistory(null)} />
    </section>
  );
}
