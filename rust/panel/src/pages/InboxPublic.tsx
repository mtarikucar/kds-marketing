import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import type {
  HandledReason,
  HeldReply,
  InboxMessage,
  PublicContext,
  PublicItem,
  ReportReason,
  Visibility,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { ErrorCallout } from '@/components/ErrorCallout';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from '@/components/ui';
import { Deadline, InboxTime, durationText, selectClass, useInboxKey, useInboxMutation } from './InboxShared';

/** An item's state as the panel shows it: its moderation when it is not visible, else its answer. */
function ItemState({ item }: { item: PublicItem }) {
  const { t } = useTranslation();
  if (item.moderation !== 'visible')
    return <Badge tone="neutral">{t(`inbox.public.moderation.${item.moderation}`)}</Badge>;
  const answer = item.answer;
  switch (answer.state) {
    case 'awaiting':
      return <Badge tone="warning">{t('inbox.public.answer.awaiting')}</Badge>;
    case 'pending':
      return <Badge tone="info">{t('inbox.public.answer.pending')}</Badge>;
    case 'answered':
      return (
        <Badge tone="success">
          {t(answer.by === 'us' ? 'inbox.public.answer.answered' : 'inbox.public.answer.answeredElsewhere')}
        </Badge>
      );
    case 'rejected':
      return <Badge tone="danger">{t('inbox.public.answer.rejected', { reason: answer.reason })}</Badge>;
    case 'handled':
      return <Badge tone="neutral">{t('inbox.public.answer.handled')}</Badge>;
    case 'expired':
      return <Badge tone="danger">{t('inbox.public.answer.expired')}</Badge>;
  }
}

/** Whether `item` may still take its one private reply now. */
function privateOpen(context: PublicContext, item: PublicItem): boolean {
  return (
    !!context.rules.private &&
    !!item.private_reply_until &&
    new Date(item.private_reply_until).getTime() > Date.now() &&
    !item.private_reply_message_id
  );
}

/** One item's actions, each with its own pending state (bug class "per-row mutation loading"). */
function ItemActions({
  context,
  item,
  owed,
  onReply,
}: {
  context: PublicContext;
  item: PublicItem;
  owed: boolean;
  onReply: () => void;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const hide = useInboxMutation(() => api.hideItem(item.id, item.moderation === 'visible'));
  const handled = useInboxMutation((reason: HandledReason) => api.markHandled([item.id], reason));
  const report = useInboxMutation((reason: ReportReason) => api.reportItem(item.id, reason));
  const [deleting, setDeleting] = useState(false);
  const [phrase, setPhrase] = useState('');
  const remove = useInboxMutation(() => api.deleteItem(item.id), () => setDeleting(false));
  const gone = item.moderation === 'deleted' || item.moderation === 'removed';
  if (gone) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {owed && (
        <Button size="sm" variant="outline" onClick={onReply}>
          {t('inbox.public.actions.reply')}
        </Button>
      )}
      {context.rules.hide && (item.moderation === 'visible' || item.moderation === 'hidden') && (
        <Button size="sm" variant="ghost" loading={hide.isPending} onClick={() => hide.mutate()}>
          {t(item.moderation === 'visible' ? 'inbox.public.actions.hide' : 'inbox.public.actions.unhide')}
        </Button>
      )}
      {owed && (
        <Button
          size="sm"
          variant="ghost"
          loading={handled.isPending}
          onClick={() => handled.mutate('no_reply_needed')}
        >
          {t('inbox.public.actions.handled')}
        </Button>
      )}
      {context.rules.report && item.moderation === 'visible' && (
        <Button size="sm" variant="ghost" loading={report.isPending} onClick={() => report.mutate('spam')}>
          {t('inbox.public.actions.report')}
        </Button>
      )}
      {context.rules.delete && manage && (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          onClick={() => {
            setPhrase('');
            setDeleting(true);
          }}
        >
          {t('inbox.public.actions.delete')}
        </Button>
      )}
      <ErrorCallout error={hide.error ?? handled.error ?? report.error} />
      <Dialog open={deleting} onOpenChange={(open) => !remove.isPending && setDeleting(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('inbox.public.delete.title')}</DialogTitle>
            <DialogDescription>{t('inbox.public.delete.description')}</DialogDescription>
          </DialogHeader>
          <label className="text-sm">
            {t('inbox.public.delete.confirm', { phrase: t('inbox.public.delete.phrase') })}
            <Input autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </label>
          <ErrorCallout error={remove.error} />
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={phrase !== t('inbox.public.delete.phrase') || remove.isPending}
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('inbox.public.delete.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A held draft: approve it as written, edit and approve it, or discard it. */
function HeldCard({ held, draft }: { held: HeldReply; draft: InboxMessage | undefined }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft?.body ?? '');
  const approve = useInboxMutation((edited: string | undefined) => api.approveReply(held.outbox_id, edited));
  const discard = useInboxMutation(() => api.discardReply(held.outbox_id));
  const busy = approve.isPending || discard.isPending;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning p-3" data-testid="held-reply">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('inbox.public.held.title')}</span>
        {held.deadline && <Deadline at={held.deadline} />}
      </div>
      {editing ? (
        <Textarea aria-label={t('inbox.public.held.text')} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
      ) : (
        <p className="whitespace-pre-wrap text-sm">{draft?.body}</p>
      )}
      <ErrorCallout error={approve.error ?? discard.error} />
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" loading={approve.isPending} disabled={busy || !text.trim()} onClick={() => approve.mutate(text.trim())}>
              {t('inbox.public.held.save')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t('inbox.public.held.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" loading={approve.isPending} disabled={busy} onClick={() => approve.mutate(undefined)}>
              {t('inbox.public.held.approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setText(draft?.body ?? '');
                setEditing(true);
              }}
            >
              {t('inbox.public.held.edit')}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" loading={discard.isPending} disabled={busy} onClick={() => discard.mutate()}>
          {t('inbox.public.held.discard')}
        </Button>
      </div>
    </div>
  );
}

/** The composer of a public conversation: one target item, its visibility, its bounds. */
function Composer({
  conversationId,
  context,
  target,
  onTarget,
}: {
  conversationId: string;
  context: PublicContext;
  target: string | null;
  onTarget: (id: string) => void;
}) {
  const { t } = useTranslation();
  const owed = context.items.filter((entry) => entry.owed);
  const item = context.items.find((entry) => entry.item.id === target)?.item;
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [text, setText] = useState('');
  // One request key per draft (a retry of the same text is the same reply).
  const request = useRef<{ text: string; key: string; target: string; visibility: Visibility }>();
  const inFlight = useRef(false);
  const send = useInboxMutation(
    async () => {
      const body = text.trim();
      if (
        !request.current ||
        request.current.text !== body ||
        request.current.target !== target ||
        request.current.visibility !== visibility
      )
        request.current = { text: body, key: crypto.randomUUID(), target: target!, visibility };
      return api.replyToItem(conversationId, {
        item_id: request.current.target,
        visibility: request.current.visibility,
        text: request.current.text,
        request_key: request.current.key,
      });
    },
    () => {
      setText('');
      request.current = undefined;
    },
  );
  if (owed.length === 0 || !item) return <p className="text-sm text-muted-foreground">{t('inbox.public.composer.noOwed')}</p>;
  const canPrivate = privateOpen(context, item);
  const mode = canPrivate ? visibility : 'public';
  const bounds =
    mode === 'private' && context.rules.private
      ? { min: 1, max: context.rules.private.max_chars }
      : context.rules.public;
  const length = [...text].length;
  const within = length >= bounds.min && length <= bounds.max && !!text.trim();
  return (
    <form
      className="flex flex-col gap-2 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        // The guard holds on Enter too (bug class "Enter double-submit"): a ref, since a second
        // submit in the same tick sees `isPending` not yet set.
        if (!within || inFlight.current) return;
        inFlight.current = true;
        send.mutate(undefined, { onSettled: () => (inFlight.current = false) });
      }}
    >
      <label className="text-sm">
        {t('inbox.public.composer.target')}
        <select
          className={selectClass}
          value={target ?? ''}
          onChange={(e) => {
            // A new target is a new draft (bug class "reused-component stale state").
            setText('');
            setVisibility('public');
            send.reset();
            request.current = undefined;
            onTarget(e.target.value);
          }}
        >
          {owed.map((entry) => (
            <option key={entry.item.id} value={entry.item.id}>
              {entry.thread.find((line) => line.external_id === entry.item.external_id)?.text ?? entry.item.external_id}
            </option>
          ))}
        </select>
      </label>
      {canPrivate && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('inbox.public.composer.visibility')}>
          {(['public', 'private'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={mode === value ? 'primary' : 'outline'}
              aria-pressed={mode === value}
              onClick={() => setVisibility(value)}
            >
              {t(`inbox.public.composer.${value}`)}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">
            {t('inbox.public.composer.privateLeft', {
              time: durationText(t, new Date(item.private_reply_until!).getTime() - Date.now()),
            })}
          </span>
        </div>
      )}
      {context.rules.marketplace && <Callout tone="info">{t('inbox.public.marketplaceNote')}</Callout>}
      {context.approval_required && <Callout tone="info">{t('inbox.public.approvalNote')}</Callout>}
      <label className="text-sm font-medium">
        {t('inbox.public.composer.label')}
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} disabled={send.isPending} />
      </label>
      <span
        data-testid="char-count"
        className={`text-xs ${length > bounds.max ? 'text-danger' : 'text-muted-foreground'}`}
      >
        {t('inbox.public.composer.count', { count: length, max: bounds.max })}
      </span>
      <ErrorCallout error={send.error} />
      <Button type="submit" loading={send.isPending} disabled={!within || send.isPending}>
        {t('inbox.public.composer.send')}
      </Button>
    </form>
  );
}

/**
 * A comment or question conversation (spec §9): each item with its post or product, its thread
 * and its state, its actions, the held drafts waiting for approval, and the composer.
 */
export function InboxPublic({
  conversationId,
  context,
  messages,
}: {
  conversationId: string;
  context: PublicContext;
  messages: InboxMessage[];
}) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const session = useSession();
  const pending = useQuery({
    queryKey: [...key, 'pending'],
    queryFn: api.getInboxPending,
    enabled: can(session.data, 'inbox.work'),
  });
  const held = (pending.data?.approvals ?? []).filter((row) => row.conversation_id === conversationId);
  // The composer answers the oldest owed item until another is chosen.
  const oldest = context.items.find((entry) => entry.owed)?.item.id ?? null;
  const [chosen, setChosen] = useState<string | null>(null);
  const target = chosen && context.items.some((entry) => entry.item.id === chosen && entry.owed) ? chosen : oldest;
  return (
    <div className="flex flex-col gap-4" data-testid="public-conversation">
      {held.map((row) => (
        <HeldCard
          key={row.outbox_id}
          held={row}
          draft={messages.find(
            (m) => m.direction === 'outbound' && m.status === 'queued' && m.item?.item_id === row.item_id,
          )}
        />
      ))}
      <ol className="flex min-w-0 flex-col gap-4" aria-label={t('inbox.public.items')}>
        {context.items.map((entry) => (
          <li key={entry.item.id} className="flex flex-col gap-2 rounded-lg border p-3" data-testid="public-item">
            {entry.subject && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="subject">
                <span>{t(`inbox.public.subject.${entry.subject.kind}`)}</span>
                {entry.subject.url ? (
                  <a className="font-medium text-foreground underline" href={entry.subject.url} target="_blank" rel="noreferrer">
                    {entry.subject.title || entry.subject.external_id}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{entry.subject.title || entry.subject.external_id}</span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <ItemState item={entry.item} />
              {entry.item.deadline && entry.owed && <Deadline at={entry.item.deadline} />}
              <InboxTime at={entry.item.created_at} />
            </div>
            <ol className="flex flex-col gap-1">
              {entry.thread.map((line, index) => (
                <li
                  key={`${line.external_id ?? ''}:${index}`}
                  className={`rounded-md p-2 text-sm [overflow-wrap:anywhere] ${
                    line.author === 'us'
                      ? 'ml-5 bg-primary/10'
                      : line.author === 'other'
                        ? 'bg-surface-muted text-muted-foreground'
                        : 'bg-surface-muted'
                  }`}
                >
                  <span className="block text-xs text-muted-foreground">{t(`inbox.public.author.${line.author}`)}</span>
                  {line.text}
                </li>
              ))}
            </ol>
            <ItemActions context={context} item={entry.item} owed={entry.owed} onReply={() => setChosen(entry.item.id)} />
          </li>
        ))}
      </ol>
      <Composer key={target ?? 'none'} conversationId={conversationId} context={context} target={target} onTarget={setChosen} />
    </div>
  );
}
