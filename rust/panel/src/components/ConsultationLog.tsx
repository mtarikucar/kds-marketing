import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CONSULTATION_PAGE_SIZE, listConsultation, recordEntry } from '@/api/strategy';
import { RECORD_KINDS, SECTION_KEYS, type RecordKind, type SectionKey } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { ActorBadge, ConsultationKindBadge } from '@/components/StatusBadges';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';

const NO_SECTION = '__none__';

function isSectionKey(key: string | null): key is SectionKey {
  return key !== null && (SECTION_KEYS as readonly string[]).includes(key);
}

/** The query key of a version's consultation log. */
export function consultationKey(versionId: string) {
  return ['strategy', 'consultation', versionId] as const;
}

function RecordForm({ onRecorded }: { onRecorded: () => Promise<void> }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<RecordKind>('note');
  const [section, setSection] = useState<string>(NO_SECTION);
  const [text, setText] = useState('');
  const record = useMutation({
    mutationFn: recordEntry,
    onSuccess: async () => {
      setText('');
      toast.success(t('strategy.consultation.recorded'));
      await onRecorded();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    record.mutate({
      kind,
      section_key: isSectionKey(section) ? section : undefined,
      text: text.trim(),
    });
  };

  return (
    <form className="flex flex-col gap-3 rounded-lg border border-border p-3" onSubmit={onSubmit} noValidate>
      <ErrorCallout error={record.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('strategy.consultation.kind')}>
          {(ids) => (
            <Select value={kind} onValueChange={(v) => setKind(v as RecordKind)}>
              <SelectTrigger id={ids.id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECORD_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`strategy.consultation.kinds.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label={t('strategy.consultation.section')}>
          {(ids) => (
            <Select value={section} onValueChange={setSection}>
              <SelectTrigger id={ids.id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SECTION}>{t('strategy.consultation.noSection')}</SelectItem>
                {SECTION_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {t(`strategy.sections.${key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>
      <Field label={t('strategy.consultation.text')} required>
        {(ids) => (
          <Textarea id={ids.id} rows={3} value={text} onChange={(e) => setText(e.target.value)} required />
        )}
      </Field>
      <Button type="submit" className="self-end" loading={record.isPending} disabled={text.trim() === ''}>
        {t('strategy.consultation.add')}
      </Button>
    </form>
  );
}

/**
 * A version's consultation log, newest first, paged by keyset ("load more"). With `canRecord`
 * (the open draft, for someone who may run the consultation), a form records a note, a
 * question, an answer or an assumption.
 */
export function ConsultationLog({ versionId, canRecord }: { versionId: string; canRecord: boolean }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const log = useInfiniteQuery({
    queryKey: consultationKey(versionId),
    queryFn: ({ pageParam }) =>
      listConsultation(versionId, {
        limit: CONSULTATION_PAGE_SIZE,
        before_at: pageParam?.at,
        before_id: pageParam?.id,
      }),
    initialPageParam: undefined as { at: string; id: string } | undefined,
    // A full page may have more behind it; the next page starts before its last (oldest) entry.
    getNextPageParam: (last) => {
      if (last.length < CONSULTATION_PAGE_SIZE) return undefined;
      const oldest = last[last.length - 1];
      return { at: oldest.at, id: oldest.id };
    },
  });
  const entries = log.data?.pages.flat() ?? [];

  const onRecorded = async () => {
    await queryClient.invalidateQueries({ queryKey: consultationKey(versionId) });
    await queryClient.invalidateQueries({ queryKey: ['strategy', 'current'] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('strategy.consultation.title')}</CardTitle>
        <CardDescription>{t('strategy.consultation.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canRecord && <RecordForm onRecorded={onRecorded} />}
        <QueryState query={log}>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('strategy.consultation.empty')}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {entries.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ConsultationKindBadge kind={entry.kind} />
                    <ActorBadge kind={entry.actor.kind} />
                    {isSectionKey(entry.section_key) && (
                      <span className="text-micro text-muted-foreground">
                        {t(`strategy.sections.${entry.section_key}`)}
                      </span>
                    )}
                    <time className="ms-auto text-micro text-muted-foreground" dateTime={entry.at}>
                      {formatDateTime(entry.at, i18n.language)}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm text-foreground">{entry.text}</p>
                </li>
              ))}
            </ol>
          )}
          {log.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              onClick={() => void log.fetchNextPage()}
              loading={log.isFetchingNextPage}
            >
              {t('strategy.consultation.loadMore')}
            </Button>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}
