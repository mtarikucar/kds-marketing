import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isApiError } from '@/api/client';
import { archiveTemplate, listTemplates, saveTemplate } from '@/api/outreach';
import { TEMPLATE_VARS, type TemplateLang, type TemplateOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  PageHeader,
  Textarea,
  toast,
} from '@/components/ui';
import { useDraftKey, useInFlight } from '@/lib/leads';
import { footerText, linksOf, parseTemplate, renderSegments, type TemplateProblem } from '@/lib/outreach';
import { can } from '@/lib/roles';
import { selectClass } from './InboxShared';
import { useLeadsKey, useLeadsRefresh } from './LeadsShared';
import { LockNotice, useOutreachSettings } from './OutreachShared';

/** A template problem in the panel's words, naming the field it is in. */
function problemText(t: TFunction, field: 'subject' | 'body', p: TemplateProblem): string {
  const where = t(`leads.templates.${field}`);
  return p.reason === 'unknown_variable'
    ? t('leads.templates.problems.unknown_variable', { where, name: p.name })
    : t(`leads.templates.problems.${p.reason}`, { where });
}

/** A server refusal of a save: an unknown variable is named, any other is the usual copy. */
function saveErrorText(t: TFunction, err: unknown): string | null {
  if (!isApiError(err) || err.code !== 'VALIDATION') return null;
  const field = err.details.field === 'subject' ? 'subject' : 'body';
  if (err.details.reason === 'unknown_variable' && typeof err.details.name === 'string') {
    return problemText(t, field, { reason: 'unknown_variable', name: err.details.name });
  }
  return null;
}

/**
 * One template's editor: variable chips, the live render with sample values and the fixed
 * footer, its links. Keyed by the template, so a draft never carries over to another.
 */
function TemplateEditor({ current, onSaved }: { current: TemplateOut | null; onSaved: (out: TemplateOut) => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const settings = useOutreachSettings();
  const refresh = useLeadsRefresh();
  const draftKey = useDraftKey();
  const guard = useInFlight();
  const [name, setName] = useState(current?.template.name ?? '');
  const [language, setLanguage] = useState<TemplateLang>(current?.template.language ?? 'tr');
  const [subject, setSubject] = useState(current?.template.subject ?? '');
  const [body, setBody] = useState(current?.template.body ?? '');
  const [basis, setBasis] = useState<'public_business_data' | 'consent'>('public_business_data');
  const canWrite = can(session.data, 'outreach.work');
  const save = useMutation({
    mutationFn: () => {
      const input = current
        ? { template_id: current.template.id, expected_revision: current.template.revision, name, language, subject, body }
        : { name, language, subject, body };
      return saveTemplate(current ? input : { ...input, request_key: draftKey.keyFor(input) });
    },
    onSuccess: async (out) => {
      toast.success(t('leads.templates.saved'));
      draftKey.reset();
      onSaved(out);
      await refresh();
    },
  });
  const archive = useMutation({
    mutationFn: () => archiveTemplate(current!.template.id),
    onSuccess: async () => {
      toast.success(t('leads.templates.archived'));
      await refresh();
    },
  });
  const parsedSubject = parseTemplate(subject);
  const parsedBody = parseTemplate(body);
  const problems = [
    parsedSubject.ok ? null : problemText(t, 'subject', parsedSubject.problem),
    parsedBody.ok ? null : problemText(t, 'body', parsedBody.problem),
  ].filter((x): x is string => x !== null);
  const s = settings.data;
  const samples: Record<string, string> = {
    first_name: t('leads.templates.samples.first_name'),
    contact_name: t('leads.templates.samples.contact_name'),
    company: t('leads.templates.samples.company'),
    city: t('leads.templates.samples.city'),
    district: t('leads.templates.samples.district'),
    sector: t('leads.templates.samples.sector'),
    sender_name: session.data?.display_name ?? '',
    sender_company: s?.sender_company ?? '',
  };
  const identity = {
    sender_company: s?.sender_company || t('leads.templates.missing.company'),
    sender_address: s?.sender_address || t('leads.templates.missing.address'),
    privacy_notice_url: s?.privacy_notice_url || t('leads.templates.missing.privacy'),
  };
  const valid = name.trim() !== '' && subject.trim() !== '' && body.trim() !== '' && problems.length === 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !canWrite) return;
    guard((release) => save.mutate(undefined, { onSettled: release }));
  };
  const insert = (v: string) => setBody((b) => `${b}{{${v}}}`);
  const links = linksOf(body);
  const serverProblem = saveErrorText(t, save.error);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('leads.templates.editor')}>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.templates.name')}
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.templates.language')}
          <select className={selectClass} value={language} onChange={(e) => setLanguage(e.target.value as TemplateLang)}>
            <option value="tr">{t('leads.templates.languages.tr')}</option>
            <option value="en">{t('leads.templates.languages.en')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.templates.subject')}
          <Input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value.replace(/[\r\n]/g, ' '))} />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span>{t('leads.templates.vars')}</span>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('leads.templates.vars')}>
            {TEMPLATE_VARS.map((v) => (
              <Button key={v} type="button" size="sm" variant="outline" onClick={() => insert(v)}>
                {`{{${v}}}`}
              </Button>
            ))}
          </div>
          <span className="text-caption text-muted-foreground">{t('leads.templates.customHint', { custom: '{{custom.…}}', fallback: '{{company|…}}' })}</span>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.templates.body')}
          <Textarea className="min-h-48 font-mono" value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
        </label>
        {problems.map((p) => (
          <Callout key={p} tone="danger">
            {p}
          </Callout>
        ))}
        {serverProblem ? <Callout tone="danger">{serverProblem}</Callout> : <ErrorCallout error={save.error} />}
        <ErrorCallout error={archive.error} />
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!valid} loading={save.isPending}>
              {current ? t('leads.templates.saveRevision') : t('leads.templates.create')}
            </Button>
            {current && !current.template.archived && (
              <Button type="button" variant="ghost" loading={archive.isPending} onClick={() => !archive.isPending && archive.mutate()}>
                {t('leads.templates.archive')}
              </Button>
            )}
          </div>
        )}
      </form>
      <section className="flex flex-col gap-3" aria-label={t('leads.templates.preview')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('leads.templates.preview')}</h2>
          <label className="flex items-center gap-2 text-sm">
            {t('leads.templates.recipient')}
            <select
              className={selectClass}
              value={basis}
              onChange={(e) => setBasis(e.target.value as 'public_business_data' | 'consent')}
            >
              <option value="public_business_data">{t('leads.templates.recipients.business')}</option>
              <option value="consent">{t('leads.templates.recipients.consent')}</option>
            </select>
          </label>
        </div>
        {s && !s.sender_identity_complete && <Callout tone="info">{t('leads.templates.identityHint')}</Callout>}
        <div className="rounded-lg border border-border p-3 text-sm">
          <p className="font-medium" data-testid="preview-subject">
            {parsedSubject.ok ? renderSegments(parsedSubject.segments, samples) : subject}
          </p>
          <pre className="mt-2 whitespace-pre-wrap font-sans" data-testid="preview-body">
            {parsedBody.ok ? renderSegments(parsedBody.segments, samples) : body}
          </pre>
          <pre className="mt-3 whitespace-pre-wrap font-sans text-muted-foreground" data-testid="preview-footer">
            {footerText(language, basis, identity, t('leads.templates.unsubscribeSample'))}
          </pre>
        </div>
        <p className="text-caption text-muted-foreground">{t('leads.templates.footerFixed')}</p>
        <div className="text-sm">
          <h3 className="font-medium">{t('leads.templates.links')}</h3>
          {links.length === 0 ? (
            <p className="text-muted-foreground">{t('leads.templates.noLinks')}</p>
          ) : (
            <ul className="list-disc ps-5" aria-label={t('leads.templates.links')}>
              {links.map((l) => (
                <li key={l} className="break-all">
                  {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

/** `/outreach/templates`: the templates and their editor (spec §9). */
export function OutreachTemplates() {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const settings = useOutreachSettings();
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const templates = useQuery({
    queryKey: [...key, 'outreach', 'templates', archived],
    queryFn: () => listTemplates({ include_archived: archived }),
  });
  const items = templates.data?.items ?? [];
  const current = items.find((x) => x.template.id === selected) ?? null;
  return (
    <>
      <PageHeader
        title={t('leads.templates.title')}
        description={t('leads.templates.description')}
        actions={
          <Button asChild variant="outline">
            <Link to="/outreach">{t('leads.outreach.title')}</Link>
          </Button>
        }
      />
      <LockNotice settings={settings.data} />
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('leads.templates.list')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button size="sm" onClick={() => setSelected('new')}>
              {t('leads.templates.new')}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
              {t('leads.templates.showArchived')}
            </label>
            <QueryState query={templates}>
              {items.length === 0 ? (
                <EmptyState title={t('leads.templates.empty')} />
              ) : (
                <ul className="flex flex-col gap-1" aria-label={t('leads.templates.list')}>
                  {items.map(({ template }) => (
                    <li key={template.id}>
                      <button
                        type="button"
                        aria-current={selected === template.id ? 'true' : undefined}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-surface-muted aria-[current]:bg-primary/10"
                        onClick={() => setSelected(template.id)}
                      >
                        <span className="truncate">{template.name}</span>
                        <span className="flex gap-1">
                          <Badge tone="neutral" size="sm">
                            {template.language.toUpperCase()}
                          </Badge>
                          {template.archived && (
                            <Badge tone="warning" size="sm">
                              {t('leads.templates.archivedBadge')}
                            </Badge>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            {selected === null ? (
              <p className="text-sm text-muted-foreground">{t('leads.templates.choose')}</p>
            ) : (
              <TemplateEditor
                key={current ? `${current.template.id}:${current.template.revision}` : 'new'}
                current={current}
                onSaved={(out) => setSelected(out.template.id)}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
