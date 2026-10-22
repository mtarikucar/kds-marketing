import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, Compass, History, Play, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listGroups } from '@/api/capabilities';
import {
  approveDraft,
  archiveVersion,
  getStrategy,
  listVersions,
  startConsultation,
  submitDraft,
} from '@/api/strategy';
import type { Gap, GroupOut, VersionOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ConsultationLog } from '@/components/ConsultationLog';
import { ErrorCallout } from '@/components/ErrorCallout';
import { GapList } from '@/components/GapList';
import { QueryState } from '@/components/QueryState';
import { VersionStatusBadge } from '@/components/StatusBadges';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@/components/ui';
import { gapsOf } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { can, canApproveStrategy } from '@/lib/roles';
import { HypothesesSection } from './strategy/HypothesesSection';
import { GROUPS_KEY, STRATEGY_KEY, VERSIONS_KEY, invalidateStrategy } from './strategy/queries';
import { SectionsView } from './strategy/sections';

type Tab = 'approved' | 'draft';

function Meta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}

/** A refusal: its gaps under a title when it lists any, else the panel's error text. */
function RefusalCallout({ error, title }: { error: unknown; title: string }) {
  const gaps = gapsOf(error);
  if (!error) return null;
  if (gaps.length === 0) return <ErrorCallout error={error} />;
  return (
    <Callout tone="danger" title={title}>
      <GapList gaps={gaps} />
    </Callout>
  );
}

/**
 * Archives the approved version. Destructive (the workspace is left without a strategy), so the
 * user types the version number before the button opens; the request names the version meant.
 */
function ArchiveDialog({
  version,
  open,
  onOpenChange,
}: {
  version: VersionOut;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const archive = useMutation({
    mutationFn: archiveVersion,
    onSuccess: async () => {
      toast.success(t('strategy.archived'));
      close(false);
      await invalidateStrategy(queryClient);
    },
  });
  const close = (next: boolean) => {
    if (!next) {
      setTyped('');
      archive.reset();
    }
    onOpenChange(next);
  };
  const matches = typed.trim() === String(version.number);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (matches) archive.mutate({ version_id: version.id, confirm: true });
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('strategy.archiveTitle')}</DialogTitle>
          <DialogDescription>{t('strategy.archiveBody', { number: version.number })}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <ErrorCallout error={archive.error} />
          <Field label={t('strategy.archiveConfirmLabel', { number: version.number })}>
            {(ids) => (
              <Input
                id={ids.id}
                inputMode="numeric"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches} loading={archive.isPending}>
              {t('strategy.archive')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const versions = useQuery({ queryKey: VERSIONS_KEY, queryFn: listVersions, enabled: open });
  const at = (iso: string | null) => (iso ? formatDateTime(iso, i18n.language) : null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full max-w-md overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('strategy.versionsTitle')}</SheetTitle>
          <SheetDescription>{t('strategy.versionsDescription')}</SheetDescription>
        </SheetHeader>
        <QueryState query={versions}>
          {versions.data && versions.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('strategy.versionsEmpty')}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {versions.data?.map((v) => (
                <li key={v.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{t('strategy.versionLabel', { number: v.number })}</span>
                    <VersionStatusBadge status={v.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-2">
                    <Meta label={t('strategy.createdAt')} value={at(v.created_at)} />
                    <Meta label={t('strategy.submittedAt')} value={at(v.submitted_at)} />
                    <Meta label={t('strategy.approvedAt')} value={at(v.approved_at)} />
                    <Meta label={t('strategy.archivedAt')} value={at(v.archived_at)} />
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </QueryState>
      </SheetContent>
    </Sheet>
  );
}

function ApprovedTab({
  version,
  canApprove,
  groups,
}: {
  version: VersionOut | null;
  canApprove: boolean;
  groups: readonly GroupOut[];
}) {
  const { t, i18n } = useTranslation();
  const [archiving, setArchiving] = useState(false);
  if (!version) {
    return <EmptyState title={t('strategy.noApproved')} description={t('strategy.noApprovedBody')} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CardTitle>{t('strategy.versionLabel', { number: version.number })}</CardTitle>
            <VersionStatusBadge status={version.status} />
          </div>
          {canApprove && (
            <Button variant="outline" onClick={() => setArchiving(true)}>
              <Archive className="h-4 w-4" aria-hidden="true" />
              {t('strategy.archive')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Meta label={t('strategy.approvedAt')} value={version.approved_at && formatDateTime(version.approved_at, i18n.language)} />
            <Meta label={t('strategy.approvedBy')} value={version.approved_by_email} />
            <Meta label={t('strategy.createdAt')} value={formatDateTime(version.created_at, i18n.language)} />
          </dl>
        </CardContent>
      </Card>
      <SectionsView sections={version.sections} editable={false} groups={groups} />
      <HypothesesSection
        hypotheses={version.hypotheses}
        segments={version.sections.audience}
        channels={version.sections.channels.map((c) => c.channel)}
        editable={false}
      />
      <ConsultationLog versionId={version.id} canRecord={false} />
      {canApprove && <ArchiveDialog version={version} open={archiving} onOpenChange={setArchiving} />}
    </div>
  );
}

function DraftTab({
  draft,
  gaps,
  canConsult,
  canApprove,
  groups,
  onApproved,
}: {
  draft: VersionOut | null;
  gaps: readonly Gap[];
  canConsult: boolean;
  canApprove: boolean;
  groups: readonly GroupOut[];
  onApproved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: startConsultation,
    onSuccess: async () => {
      toast.success(t('strategy.started'));
      await invalidateStrategy(queryClient);
    },
  });
  const submit = useMutation({
    mutationFn: submitDraft,
    onSuccess: async () => {
      toast.success(t('strategy.submitted'));
      await invalidateStrategy(queryClient);
    },
  });
  const approve = useMutation({
    mutationFn: approveDraft,
    onSuccess: async () => {
      toast.success(t('strategy.approved'));
      onApproved();
      await invalidateStrategy(queryClient);
    },
  });

  if (!draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('strategy.noDraft')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('strategy.noDraftBody')}</p>
          <ErrorCallout error={start.error} />
          {canConsult && (
            <Button className="self-start" onClick={() => start.mutate()} loading={start.isPending}>
              <Play className="h-4 w-4" aria-hidden="true" />
              {t('strategy.start')}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const submitted = draft.submitted_at !== null;
  const approveHint = !canApprove
    ? t('strategy.approveOwnerOnly')
    : !submitted
      ? t('strategy.approveNeedsSubmit')
      : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{t('strategy.versionLabel', { number: draft.number })}</CardTitle>
            <VersionStatusBadge status={draft.status} />
            <Badge tone={submitted ? 'primary' : 'neutral'} size="sm">
              {submitted ? t('strategy.submittedBadge') : t('strategy.notSubmittedBadge')}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canConsult && (
              <Button variant="outline" onClick={() => submit.mutate()} loading={submit.isPending}>
                <Send className="h-4 w-4" aria-hidden="true" />
                {t('strategy.submit')}
              </Button>
            )}
            <Button
              onClick={() => approve.mutate()}
              loading={approve.isPending}
              disabled={!canApprove || !submitted}
              aria-describedby={approveHint ? 'strategy-approve-hint' : undefined}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {t('strategy.approve')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {approveHint && (
            <p id="strategy-approve-hint" className="text-caption text-muted-foreground">
              {approveHint}
            </p>
          )}
          <dl className="grid gap-3 sm:grid-cols-3">
            <Meta label={t('strategy.createdAt')} value={formatDateTime(draft.created_at, i18n.language)} />
            <Meta label={t('strategy.submittedAt')} value={draft.submitted_at && formatDateTime(draft.submitted_at, i18n.language)} />
          </dl>
          <RefusalCallout error={submit.error} title={t('strategy.submitRefused')} />
          <RefusalCallout error={approve.error} title={t('strategy.gapsTitle')} />
        </CardContent>
      </Card>

      {gaps.length > 0 ? (
        <Callout tone="warning" title={t('strategy.gapsTitle')}>
          <GapList gaps={gaps} />
        </Callout>
      ) : (
        <Callout tone="success">{t('strategy.noGaps')}</Callout>
      )}

      <SectionsView sections={draft.sections} editable={canConsult} groups={groups} />
      <HypothesesSection
        hypotheses={draft.hypotheses}
        segments={draft.sections.audience}
        channels={draft.sections.channels.map((c) => c.channel)}
        editable={canConsult}
      />
      <ConsultationLog versionId={draft.id} canRecord={canConsult} />
    </div>
  );
}

export function StrategyPage() {
  const { t } = useTranslation();
  const session = useSession();
  const canConsult = can(session.data, 'team.manage');
  const canApprove = canApproveStrategy(session.data);
  const strategy = useQuery({ queryKey: STRATEGY_KEY, queryFn: getStrategy });
  // Groups only name a channel's group; without them (or while they fail) ids are shown.
  const groups = useQuery({ queryKey: GROUPS_KEY, queryFn: listGroups });
  const [tab, setTab] = useState<Tab | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const data = strategy.data;
  const active: Tab = tab ?? (data?.draft ? 'draft' : data?.approved ? 'approved' : 'draft');

  return (
    <>
      <PageHeader
        title={t('strategy.title')}
        description={t('strategy.description')}
        actions={
          <Button variant="outline" onClick={() => setVersionsOpen(true)}>
            <History className="h-4 w-4" aria-hidden="true" />
            {t('strategy.versions')}
          </Button>
        }
      />
      <QueryState query={strategy}>
        {data && (
          <Tabs value={active} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="approved">
                <Compass className="me-1.5 h-4 w-4" aria-hidden="true" />
                {t('strategy.tabs.approved')}
              </TabsTrigger>
              <TabsTrigger value="draft">{t('strategy.tabs.draft')}</TabsTrigger>
            </TabsList>
            <TabsContent value="approved">
              <ApprovedTab version={data.approved} canApprove={canApprove} groups={groups.data ?? []} />
            </TabsContent>
            <TabsContent value="draft">
              <DraftTab
                draft={data.draft}
                gaps={data.gaps}
                canConsult={canConsult}
                canApprove={canApprove}
                groups={groups.data ?? []}
                onApproved={() => setTab('approved')}
              />
            </TabsContent>
          </Tabs>
        )}
      </QueryState>
      <VersionsSheet open={versionsOpen} onOpenChange={setVersionsOpen} />
    </>
  );
}
