import { useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import { isApiError } from '@/api/client';
import { QueryState } from '@/components/QueryState';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, Callout, Disclosure, Input, Textarea } from '@/components/ui';
import { kindLabel } from '@/lib/capabilities';
import { deliveryText } from '@/lib/delivery';
import { personName } from '@/lib/people';
import { InboxCompliance } from './InboxCompliance';
import { InboxErasure } from './InboxErasure';
import { InboxJourneyPanel } from './InboxJourneyPanel';
import { InboxPublic } from './InboxPublic';
import {
  conversationClass,
  journeyClass,
  Deadline,
  InboxActorLabel,
  InboxTime,
  useInboxKey,
  useInboxMutation,
  useMemberName,
} from './InboxShared';

export function InboxConversation({ id }: { id: string }) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const conversation = useQuery({
    queryKey: [...key, 'conversation', id],
    queryFn: () => api.getConversation(id),
  });
  const context = useQuery({ queryKey: [...key, 'context', id], queryFn: () => api.getContext(id) });
  const personId = conversation.data?.person_id;
  const person = useQuery({
    queryKey: [...key, 'person', personId],
    queryFn: () => api.getPerson(personId!),
    enabled: !!personId,
  });
  const memberName = useMemberName();
  const messages = useInfiniteQuery({
    queryKey: [...key, 'messages', id],
    queryFn: ({ pageParam }) => api.listMessages(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [until, setUntil] = useState('');
  const request = useRef<{ text: string; subject?: string; key: string }>();
  const send = useInboxMutation(
    async () => {
      // An empty subject lets the server answer the original one ("Re: <subject>").
      const emailSubject = conversation.data?.kind_key === 'mailbox' ? subject.trim() || undefined : undefined;
      if (!request.current || request.current.text !== text.trim() || request.current.subject !== emailSubject)
        request.current = { text: text.trim(), subject: emailSubject, key: crypto.randomUUID() };
      return api.reply(id, request.current.text, request.current.key, request.current.subject);
    },
    () => {
      setText('');
      setSubject('');
      request.current = undefined;
    },
  );
  const action = useInboxMutation((value: 'take-over' | 'hand-to-agent' | 'unsnooze' | 'close') =>
    api.conversationAction(id, value),
  );
  const snooze = useInboxMutation(
    () => api.snooze(id, new Date(until).toISOString()),
    () => setUntil(''),
  );
  const row = conversation.data;
  const ctx = context.data;
  // Context's human-held prohibition applies to agents only, never to this human composer.
  const reason =
    ctx?.journey?.status === 'lost'
      ? 'journey_lost'
      : ctx?.person.erased_at
        ? 'person_erased'
        : ctx?.person.merged_into
          ? 'person_merged'
          : null;
  const refusal =
    isApiError(send.error) && send.error.code === 'FORBIDDEN' && typeof send.error.details.reason === 'string'
      ? send.error.details.reason
      : null;
  const disabled = !!reason || (!!refusal && refusal !== 'human_holds_conversation');
  return (
    <>
      <section className={conversationClass} aria-label={t('inbox.thread')}>
        <QueryState query={conversation}>
          {row && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-display text-lg font-medium leading-7">
                    {ctx ? personName(t, ctx.person, person.data?.identities) : t('inbox.thread')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">{kindLabel(t, row.kind_key)}</p>
                  {row.next_deadline && <Deadline at={row.next_deadline} />}
                </div>
                <span className="pt-1 text-caption text-muted-foreground">
                  {row.executor === 'agent'
                    ? t('inbox.agentExecutor')
                    : row.executor.human.user_id
                      ? t('inbox.humanExecutor', { user: memberName(row.executor.human.user_id) })
                      : t('inbox.unassignedExecutor')}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 border-b border-border pb-3" role="group" aria-label={t('inbox.thread')}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={action.isPending}
                  onClick={() => action.mutate('take-over')}
                >
                  {t('inbox.takeOver')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={action.isPending}
                  onClick={() => action.mutate('hand-to-agent')}
                >
                  {t('inbox.handBack')}
                </Button>
                {typeof row.state === 'object' && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={action.isPending}
                    onClick={() => action.mutate('unsnooze')}
                  >
                    {t('inbox.unsnooze')}
                  </Button>
                )}
                {row.state !== 'closed' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={action.isPending}
                    onClick={() => action.mutate('close')}
                  >
                    {t('inbox.close')}
                  </Button>
                )}
              </div>
              <ErrorCallout error={action.error} />
              {typeof row.state === 'object' && (
                <p className="text-sm">
                  {t('inbox.snoozedUntil')} <InboxTime at={row.state.snoozed.until} />
                </p>
              )}
              {row.surface === 'public' && ctx?.public ? (
                <QueryState query={messages}>
                  <InboxPublic
                    conversationId={id}
                    context={ctx.public}
                    messages={messages.data?.pages.flatMap((page) => page.items) ?? []}
                  />
                </QueryState>
              ) : (
                <>
              <QueryState query={messages}>
                {messages.hasNextPage && (
                  <Button
                    variant="ghost"
                    loading={messages.isFetchingNextPage}
                    onClick={() => void messages.fetchNextPage()}
                  >
                    {t('inbox.moreMessages')}
                  </Button>
                )}
                <ol className="flex max-h-[56dvh] min-h-48 min-w-0 shrink-0 scroll-py-4 flex-col gap-3 overflow-y-auto overscroll-contain py-4 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} aria-label={t('inbox.messages')}>
                  {messages.data?.pages
                    .flatMap((page) => page.items)
                    .slice()
                    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
                    .map((message) => (
                      <li
                        key={message.id}
                        className={`max-w-[92%] rounded-lg border px-3 py-2 ${message.direction === 'outbound' ? 'ml-auto border-primary-100 bg-primary-50/60 dark:border-primary-900 dark:bg-primary-950/40' : 'mr-auto border-border bg-surface'}`}
                      >
                        <div className="flex flex-wrap justify-between gap-2">
                          <InboxActorLabel actor={message.author} />
                          <InboxTime at={message.at} />
                        </div>
                        <p className="my-1.5 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                          {message.body}
                        </p>
                        <p className={`text-xs ${message.failure_reason ? 'text-danger' : 'text-muted-foreground'}`}>
                          {deliveryText(t, message)}
                        </p>
                      </li>
                    ))}
                </ol>
                {messages.data?.pages[0]?.items.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('inbox.noMessages')}</p>
                )}
              </QueryState>
              <QueryState query={context} />
              {reason && <Callout tone="warning">{t(`inbox.fence.${reason}`)}</Callout>}
              <form
                className="flex flex-col gap-3 border-t border-border pt-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim() && !disabled && ctx) send.mutate();
                }}
              >
                  {row.kind_key === 'mailbox' && <Input aria-label={t('inbox.emailSubject')} placeholder={t('inbox.emailSubject')} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={998} />}
                <label className="flex flex-col gap-2 text-sm font-medium">
                  {t('inbox.reply')}
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={disabled || send.isPending || !ctx}
                    rows={4}
                    className="resize-y rounded-md bg-surface"
                  />
                </label>
                <ErrorCallout error={send.error} />
                {refusal && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      send.reset();
                      void context.refetch();
                      void conversation.refetch();
                    }}
                  >
                    {t('common.retry')}
                  </Button>
                )}
                <Button className="self-end" type="submit" loading={send.isPending} disabled={disabled || !text.trim() || !ctx}>
                  {t('inbox.send')}
                </Button>
              </form>
                </>
              )}
              <form
                className="flex flex-wrap items-end gap-2 border-t border-border pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (until) snooze.mutate();
                }}
              >
                <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                  {t('inbox.snoozeUntil')}
                  <Input
                    required
                    type="datetime-local"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="outline"
                  loading={snooze.isPending}
                  disabled={!until || new Date(until).getTime() <= Date.now()}
                >
                  {t('inbox.snooze')}
                </Button>
                <ErrorCallout error={snooze.error} />
              </form>
              {ctx && !ctx.person.erased_at && !ctx.person.merged_into && (
                <div className="space-y-4 pt-1">
                  <Disclosure key={ctx.person.id} title={t('inbox.compliance.title')}>
                    <InboxCompliance personId={ctx.person.id} />
                  </Disclosure>
                  <InboxErasure key={`erase:${ctx.person.id}`} personId={ctx.person.id} />
                </div>
              )}
            </>
          )}
        </QueryState>
      </section>
      {ctx?.journey ? (
        <InboxJourneyPanel
          key={ctx.journey.id}
          journeyId={ctx.journey.id}
          personId={ctx.person.id}
          reopenInbound={row?.state === 'ours' && !!row.last_inbound_at}
        />
      ) : (
        <section className={journeyClass}>
          <h2 className="text-sm font-medium">{t('inbox.journey')}</h2>
          <QueryState query={context}>
            {ctx && <p className="text-sm text-muted-foreground">{t('inbox.noJourney')}</p>}
          </QueryState>
        </section>
      )}
    </>
  );
}
