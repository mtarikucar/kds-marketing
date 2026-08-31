/**
 * McpConsolePage — the MCP connector management console (Faz 4 frontend).
 *
 * The operator-facing mirror of everything Faz 1-3 built: which Claude clients
 * are connected, whether the human approval gate is armed, and what the
 * connector actually did. Four sections, in the order an operator needs them:
 *
 *   1. Overview   — the endpoint to paste into a client, live/pending counts.
 *   2. Write mode — the APPROVAL ⇄ AUTONOMOUS switch (OWNER-only).
 *   3. Connections— OAuth clients (revocable) + the MCP API keys (read-only).
 *   4. Sessions   — a paginated audit list; a row opens its tool-call detail.
 *
 * Two deliberate honesty rules run through the whole page:
 *
 *  - The write-mode switch is rendered from `overview.canToggle`, which mirrors
 *    BOTH gates on the real PATCH (`@MarketingRoles('OWNER')` +
 *    `@RequirePermission('settings.manage')`). A MANAGER sees the mode, sees a
 *    DISABLED switch, and is told why — never a control whose click 403s.
 *
 *  - The audit view shows tool NAMES, timings, outcomes, argument KEY NAMES and
 *    payload SIZES. The backend deliberately returns no payload bodies (they
 *    hold customer PII), so this page presents sizes and key names AS sizes and
 *    key names, with a note saying so. It must never look like a payload viewer.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Plug,
  Clipboard,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  KeyRound,
  ListChecks,
  ExternalLink,
  ScrollText,
} from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  getMcpConsoleOverview,
  getMcpConnections,
  revokeMcpOAuthConnection,
  listMcpSessions,
  getMcpSession,
  setMcpWriteMode,
  setResearchExecution,
  type McpOAuthConnection,
  type McpSessionSummary,
  type McpWriteMode,
  type ResearchExecution,
} from '../../../../features/marketing/api/mcpConsole.service';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import { copyToClipboard } from '../../../../lib/clipboard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Switch } from '@/components/ui/Switch';
import { Label } from '@/components/ui/Label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Callout } from '@/components/ui/Callout';
import { Pagination } from '@/components/ui/Pagination';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Separator } from '@/components/ui/Separator';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/Sheet';

/** Matches `MCP_SESSIONS_DEFAULT_PAGE_SIZE` on the backend. */
const SESSION_PAGE_SIZE = 25;

/** Where the human approval queue already lives (Autopilot console → Approvals). */
const APPROVAL_QUEUE_PATH = '/studio';

const QK = {
  overview: ['marketing', 'mcp-console', 'overview'] as const,
  connections: ['marketing', 'mcp-console', 'connections'] as const,
  sessions: (page: number) => ['marketing', 'mcp-console', 'sessions', page] as const,
  session: (id: string) => ['marketing', 'mcp-console', 'session', id] as const,
};

export default function McpConsolePage() {
  const { t } = useTranslation('marketing');

  return (
    <div className="space-y-5 p-4 md:p-6">
      <PageHeader
        title={t('mcpConsole.title', 'Claude connector')}
        description={t(
          'mcpConsole.subtitle',
          'Connect Claude to this workspace over MCP, control whether it needs your approval to act, and audit everything it did.',
        )}
      />
      <OverviewSection />
      <WriteModeSection />
      <ResearchExecutionSection />
      <ConnectionsSection />
      <SessionsSection />
    </div>
  );
}

// ── 1. Overview ──────────────────────────────────────────────────────────────

function OverviewSection() {
  const { t } = useTranslation('marketing');
  const q = useQuery({ queryKey: QK.overview, queryFn: getMcpConsoleOverview });

  const copy = async (value: string) => {
    if (await copyToClipboard(value)) {
      toast.success(t('common.copied', 'Copied'));
    } else {
      toast.error(
        t('mcpConsole.copyFailed', 'Could not copy — select the address and copy it manually.'),
      );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('mcpConsole.overview.title', 'Connector endpoint')}</CardTitle>
        <CardDescription>
          {t(
            'mcpConsole.overview.desc',
            'Paste this address into Claude (Settings → Connectors) to link it to this workspace.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStateBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          onRetry={() => q.refetch()}
          errorMessage={t('mcpConsole.loadFailed', 'Could not load the connector console.')}
          retryLabel={t('common.retry', 'Retry')}
        >
          {q.data && (
            <div className="space-y-4">
              {q.data.mcpEndpoint ? (
                <div className="flex items-center gap-2">
                  <code
                    data-testid="mcp-endpoint"
                    className="min-w-0 flex-1 truncate rounded border border-border bg-surface px-2 py-1.5 text-xs"
                  >
                    {q.data.mcpEndpoint}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('mcpConsole.copyEndpoint', 'Copy connector address')}
                    onClick={() => copy(q.data!.mcpEndpoint!)}
                  >
                    <Clipboard className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <Callout tone="warning" title={t('mcpConsole.noEndpointTitle', 'No public address')}>
                  {t(
                    'mcpConsole.noEndpoint',
                    'This deployment has no public base URL configured, so there is no address to hand to a client yet.',
                  )}
                </Callout>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Metric
                  icon={<Plug className="h-4 w-4" aria-hidden="true" />}
                  label={t('mcpConsole.stat.live', 'Live connections')}
                  value={String(q.data.liveConnectionCount)}
                />
                <Link
                  to={APPROVAL_QUEUE_PATH}
                  className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Metric
                    icon={<ListChecks className="h-4 w-4" aria-hidden="true" />}
                    label={t('mcpConsole.stat.pending', 'Waiting for your approval')}
                    value={String(q.data.pendingApprovalCount)}
                    hint={t('mcpConsole.stat.pendingHint', 'Open the approval queue')}
                    tone={q.data.pendingApprovalCount > 0 ? 'warning' : 'neutral'}
                  />
                </Link>
                <Metric
                  icon={
                    q.data.mcpWriteMode === 'AUTONOMOUS' ? (
                      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    )
                  }
                  label={t('mcpConsole.stat.mode', 'Write mode')}
                  value={
                    q.data.mcpWriteMode === 'AUTONOMOUS'
                      ? t('mcpConsole.mode.AUTONOMOUS', 'Autonomous')
                      : t('mcpConsole.mode.APPROVAL', 'Needs approval')
                  }
                  tone={q.data.mcpWriteMode === 'AUTONOMOUS' ? 'danger' : 'success'}
                />
              </div>
            </div>
          )}
        </QueryStateBoundary>
      </CardContent>
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className={`mt-1 font-display text-h3 ${toneClass}`}>{value}</p>
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ── 2. Write mode ────────────────────────────────────────────────────────────

/**
 * The APPROVAL ⇄ AUTONOMOUS switch.
 *
 * Turning it ON removes the human gate on send/publish/spend, so it goes
 * through a confirm step that spells out the consequence. Turning it OFF
 * TIGHTENS the gate and needs no confirmation — asking twice to become safer
 * only trains people to click through the dialog.
 */
function WriteModeSection() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const q = useQuery({ queryKey: QK.overview, queryFn: getMcpConsoleOverview });
  const mode: McpWriteMode = q.data?.mcpWriteMode ?? 'APPROVAL';
  const canToggle = q.data?.canToggle === true;
  const autonomous = mode === 'AUTONOMOUS';

  const save = useMutation({
    mutationFn: (next: McpWriteMode) => setMcpWriteMode(next),
    onSuccess: (_res, next) => {
      qc.invalidateQueries({ queryKey: QK.overview });
      setConfirmOpen(false);
      toast.success(
        next === 'AUTONOMOUS'
          ? t(
              'mcpConsole.writeMode.autonomousToast',
              'Autonomous — Claude can now send, publish and spend without asking.',
            )
          : t(
              'mcpConsole.writeMode.approvalToast',
              'Approval required — every write Claude attempts now waits for a human.',
            ),
      );
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('mcpConsole.writeMode.error', 'Could not change the write mode.'),
      ),
  });

  const onSwitch = (checked: boolean) => {
    // Loosening the gate is confirmed; tightening it applies straight away.
    if (checked) setConfirmOpen(true);
    else save.mutate('APPROVAL');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('mcpConsole.writeMode.title', 'Write mode')}</CardTitle>
        <CardDescription>
          {t(
            'mcpConsole.writeMode.desc',
            'Decides whether Claude may act on its own or has to ask you first. Reads are always allowed; this only governs writes — sending messages, publishing content and moving ad budget.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="mcp-write-mode" className="text-sm font-medium">
              {t('mcpConsole.writeMode.switchLabel', 'Let Claude act without approval')}
            </Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {autonomous
                ? t(
                    'mcpConsole.writeMode.stateAutonomous',
                    'AUTONOMOUS — no human gate. Claude sends, publishes and spends on its own.',
                  )
                : t(
                    'mcpConsole.writeMode.stateApproval',
                    'APPROVAL — every write Claude attempts is queued for a human to approve.',
                  )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={autonomous ? 'danger' : 'success'} size="sm">
              {autonomous
                ? t('mcpConsole.mode.AUTONOMOUS', 'Autonomous')
                : t('mcpConsole.mode.APPROVAL', 'Needs approval')}
            </Badge>
            <Switch
              id="mcp-write-mode"
              checked={autonomous}
              disabled={!canToggle || save.isPending || q.isLoading}
              onCheckedChange={onSwitch}
              aria-label={t('mcpConsole.writeMode.switchLabel', 'Let Claude act without approval')}
            />
          </div>
        </div>

        {!q.isLoading && !canToggle && (
          <Callout tone="info" title={t('mcpConsole.writeMode.lockedTitle', 'Read-only for you')}>
            {t(
              'mcpConsole.writeMode.locked',
              'Only a workspace owner with the "manage settings" permission can change the write mode. You can see the current setting but not change it.',
            )}
          </Callout>
        )}

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open) setConfirmOpen(false);
          }}
          title={t('mcpConsole.writeMode.confirmTitle', 'Remove the human approval gate?')}
          description={t(
            'mcpConsole.writeMode.confirmDesc',
            'In AUTONOMOUS mode Claude no longer asks anyone: it can message your customers, publish posts, spend AI credits and move real ad budget the moment a connected client tells it to. Only permanent deletions still queue for your approval. You can switch back at any time.',
          )}
          confirmLabel={t('mcpConsole.writeMode.confirmCta', 'Yes, go autonomous')}
          cancelLabel={t('common.cancel', 'Cancel')}
          tone="danger"
          loading={save.isPending}
          onConfirm={() => save.mutate('AUTONOMOUS')}
        />
      </CardContent>
    </Card>
  );
}

// ── 2b. Who drains the nightly research queue ────────────────

/**
 * The SERVER ⇄ MCP switch for `Workspace.researchExecution`.
 *
 * `PATCH marketing/workspaces/research-execution` shipped OWNER-only, audited
 * and DTO-validated, with no frontend at all — while the connector doc and
 * `claim_research_job`'s own refusal text both told owners to "switch it in
 * Settings". An owner could not turn the feature on without a curl.
 *
 * Same shape as WriteModeSection above, and the risky direction is likewise
 * confirmed — but it is the OPPOSITE direction. Turning this ON does not loosen
 * a gate; it makes the PLATFORM stop draining. With no scheduled task on the
 * other side the jobs pile up, no candidates appear, and the review queue reads
 * exactly like "research ran and found nothing". Handing the queue BACK is the
 * safe direction and applies immediately.
 */
function ResearchExecutionSection() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const q = useQuery({ queryKey: QK.overview, queryFn: getMcpConsoleOverview });
  // Fail-safe in the SERVER direction, matching the backend: anything that is
  // not exactly 'MCP' means the platform is still draining, and a switch drawn
  // the other way would tell an owner their Claude owes work it does not.
  const mode: ResearchExecution = q.data?.researchExecution === 'MCP' ? 'MCP' : 'SERVER';
  const canToggle = q.data?.canToggle === true;
  const onMcp = mode === 'MCP';
  // The gate that makes this lane half-work. Only shown when it actually
  // applies — a warning that is always on screen is a warning nobody reads.
  const gatedByApproval = onMcp && q.data?.mcpWriteMode !== 'AUTONOMOUS';

  const save = useMutation({
    mutationFn: (next: ResearchExecution) => setResearchExecution(next),
    onSuccess: (_res, next) => {
      qc.invalidateQueries({ queryKey: QK.overview });
      setConfirmOpen(false);
      toast.success(
        next === 'MCP'
          ? t(
              'mcpConsole.researchExecution.mcpToast',
              'Your Claude drains the research queue now — the platform has stopped. Nothing runs until a connected client claims the jobs.',
            )
          : t(
              'mcpConsole.researchExecution.serverToast',
              'The platform drains the research queue again.',
            ),
      );
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('mcpConsole.researchExecution.error', 'Could not change who runs the research.'),
      ),
  });

  const onSwitch = (checked: boolean) => {
    // Handing the queue away is confirmed; taking it back applies straight away.
    if (checked) setConfirmOpen(true);
    else save.mutate('SERVER');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('mcpConsole.researchExecution.title', 'Who runs the nightly research')}
        </CardTitle>
        <CardDescription>
          {t(
            'mcpConsole.researchExecution.desc',
            'Prospect research is the most expensive thing this product does. You can have your own Claude do the searching and reasoning on your subscription instead of ours — the briefs, the queue and the review step stay exactly the same.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="research-execution" className="text-sm font-medium">
              {t(
                'mcpConsole.researchExecution.switchLabel',
                'Let my Claude run the nightly research',
              )}
            </Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {onMcp
                ? t(
                    'mcpConsole.researchExecution.stateMcp',
                    'MCP — your Claude drains the queue. If nothing claims the jobs they simply pile up and no prospects appear.',
                  )
                : t(
                    'mcpConsole.researchExecution.stateServer',
                    'SERVER — the platform runs the nightly research for you, on our key.',
                  )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={onMcp ? 'warning' : 'success'} size="sm">
              {onMcp
                ? t('mcpConsole.researchExecution.MCP', 'Your Claude')
                : t('mcpConsole.researchExecution.SERVER', 'Platform')}
            </Badge>
            <Switch
              id="research-execution"
              checked={onMcp}
              disabled={!canToggle || save.isPending || q.isLoading}
              onCheckedChange={onSwitch}
              aria-label={t(
                'mcpConsole.researchExecution.switchLabel',
                'Let my Claude run the nightly research',
              )}
            />
          </div>
        </div>

        {gatedByApproval && (
          <Callout
            tone="warning"
            title={t(
              'mcpConsole.researchExecution.needsAutonomousTitle',
              'This lane needs autonomous write mode',
            )}
          >
            {t(
              'mcpConsole.researchExecution.needsAutonomous',
              'While writes need approval, the Google Maps and page-fetch tools your Claude uses to find the pain signal answer "waiting for approval" instead of returning results — and an approved call is replayed to you, never handed back into the session that asked for it, however fast you click. Your Claude falls back to plain web search and the prospects come out weaker. Switch write mode to autonomous above to run this as designed.',
            )}
          </Callout>
        )}

        {!q.isLoading && !canToggle && (
          <Callout
            tone="info"
            title={t('mcpConsole.researchExecution.lockedTitle', 'Read-only for you')}
          >
            {t(
              'mcpConsole.researchExecution.locked',
              'Only a workspace owner with the "manage settings" permission can change who runs the research. You can see the current setting but not change it.',
            )}
          </Callout>
        )}

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open) setConfirmOpen(false);
          }}
          title={t(
            'mcpConsole.researchExecution.confirmTitle',
            'Hand the nightly research to your own Claude?',
          )}
          description={t(
            'mcpConsole.researchExecution.confirmDesc',
            'From the moment you save this, the platform stops draining your research queue. Nothing runs until a connected Claude claims the jobs itself — so you need a scheduled task on your side that calls the connector. Until then the queue fills up and no new prospects appear, which on screen looks the same as research finding nothing. You can hand it back at any time.',
          )}
          confirmLabel={t('mcpConsole.researchExecution.confirmCta', 'Yes, my Claude drains it')}
          cancelLabel={t('common.cancel', 'Cancel')}
          // Not `danger`: this destroys nothing and the switch back is one
          // click away. What it needs is the WARNING in the description, which
          // no button colour could carry.
          tone="default"
          loading={save.isPending}
          onConfirm={() => save.mutate('MCP')}
        />
      </CardContent>
    </Card>
  );
}

// ── 3. Connections ───────────────────────────────────────────────────────────

function ConnectionsSection() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [revokeTarget, setRevokeTarget] = useState<McpOAuthConnection | null>(null);

  const q = useQuery({ queryKey: QK.connections, queryFn: getMcpConnections });

  const revoke = useMutation({
    mutationFn: (clientId: string) => revokeMcpOAuthConnection(clientId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: QK.connections });
      qc.invalidateQueries({ queryKey: QK.overview });
      setRevokeTarget(null);
      toast.success(
        t('mcpConsole.connections.revokeSuccess', 'Disconnected — {{count}} token(s) revoked.', {
          count: res.revoked,
        }),
      );
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('mcpConsole.connections.revokeFailed', 'Could not disconnect that client.'),
      ),
  });

  const oauth = q.data?.oauth ?? [];
  const apiKeys = q.data?.apiKeys ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('mcpConsole.connections.title', 'Connections')}</CardTitle>
        <CardDescription>
          {t(
            'mcpConsole.connections.desc',
            'Everything that can currently reach this workspace over MCP — Claude apps that you authorised, plus the API keys used by Claude Code.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <QueryStateBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          onRetry={() => q.refetch()}
          errorMessage={t('mcpConsole.connections.loadFailed', 'Could not load the connections.')}
          retryLabel={t('common.retry', 'Retry')}
        >
          {/* OAuth clients */}
          <section aria-labelledby="mcp-oauth-heading" className="space-y-3">
            <h3 id="mcp-oauth-heading" className="text-sm font-semibold text-foreground">
              {t('mcpConsole.connections.oauthTitle', 'Authorised Claude apps')}
            </h3>
            {oauth.length === 0 ? (
              <EmptyState
                icon={<Plug className="h-10 w-10" />}
                title={t('mcpConsole.connections.oauthEmpty', 'No Claude app is connected')}
                description={t(
                  'mcpConsole.connections.oauthEmptyHint',
                  'Add the connector address above in Claude and approve the consent screen — the app will appear here.',
                )}
              />
            ) : (
              <ul className="space-y-3">
                {oauth.map((c) => (
                  <li
                    key={c.clientId}
                    data-testid="mcp-oauth-connection"
                    className="rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {c.clientName ??
                            t('mcpConsole.connections.unknownClient', 'Unnamed client')}
                        </p>
                        {/* The client_id IS the identity — shown in full so an
                            operator can tell a real Claude client from a
                            look-alike before deciding to keep it. */}
                        <code className="block break-all text-micro text-muted-foreground">
                          {c.clientId}
                        </code>
                        {c.clientUri && (
                          <a
                            href={c.clientUri}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-1 inline-flex items-center gap-1 text-micro text-primary hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            {c.clientUri}
                          </a>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-danger hover:bg-danger-subtle"
                        onClick={() => setRevokeTarget(c)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        {t('mcpConsole.connections.revoke', 'Revoke')}
                      </Button>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {c.scopes.map((s) => (
                        <Badge key={s} tone="neutral" size="sm">
                          {s}
                        </Badge>
                      ))}
                    </div>

                    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-micro text-muted-foreground sm:grid-cols-3">
                      <div>
                        <dt className="inline">
                          {t('mcpConsole.connections.connectedAt', 'Connected')}:{' '}
                        </dt>
                        <dd className="inline">
                          {c.connectedAt ? fmtDateTime(c.connectedAt) : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">
                          {t('mcpConsole.connections.lastActivity', 'Last activity')}:{' '}
                        </dt>
                        <dd className="inline">
                          {c.lastActivityAt ? fmtDateTime(c.lastActivityAt) : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">
                          {t('mcpConsole.connections.liveTokens', 'Live tokens')}:{' '}
                        </dt>
                        <dd className="inline">{c.liveTokenCount}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Separator />

          {/* API keys — read-only mirror; management lives on its own page. */}
          <section aria-labelledby="mcp-keys-heading" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 id="mcp-keys-heading" className="text-sm font-semibold text-foreground">
                {t('mcpConsole.connections.keysTitle', 'API keys with MCP access')}
              </h3>
              <Link
                to="/settings/api-keys"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                {t('mcpConsole.connections.manageKeys', 'Manage API keys')}
              </Link>
            </div>
            <p className="text-micro text-muted-foreground">
              {t(
                'mcpConsole.connections.keysHint',
                'Listed here for visibility only — create and revoke keys on the API keys page.',
              )}
            </p>
            {apiKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('mcpConsole.connections.keysEmpty', 'No active API keys.')}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {apiKeys.map((k) => (
                  <li
                    key={k.id}
                    data-testid="mcp-api-key"
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{k.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} tone="neutral" size="sm">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <span className="text-micro text-muted-foreground">
                      {k.lastUsedAt
                        ? t('mcpConsole.connections.keyLastUsed', 'Last used {{when}}', {
                            when: fmtDateTime(k.lastUsedAt),
                          })
                        : t('mcpConsole.connections.keyNeverUsed', 'Never used')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </QueryStateBoundary>

        <ConfirmDialog
          open={!!revokeTarget}
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
          title={t('mcpConsole.connections.revokeTitle', 'Disconnect this client?')}
          description={t(
            'mcpConsole.connections.revokeDesc',
            'Every token this app holds for this workspace is revoked immediately, and it loses access until someone authorises it again. Its audit trail is kept.',
          )}
          confirmLabel={t('mcpConsole.connections.revoke', 'Revoke')}
          cancelLabel={t('common.cancel', 'Cancel')}
          tone="danger"
          loading={revoke.isPending}
          onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.clientId)}
        />
      </CardContent>
    </Card>
  );
}

// ── 4. Sessions & audit ──────────────────────────────────────────────────────

function SessionsSection() {
  const { t } = useTranslation('marketing');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: QK.sessions(page),
    queryFn: () => listMcpSessions(page, SESSION_PAGE_SIZE),
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (q.data?.pageSize ?? SESSION_PAGE_SIZE)));

  const columns: ColumnDef<McpSessionSummary, unknown>[] = [
    {
      accessorKey: 'status',
      header: t('mcpConsole.sessions.col.status', 'Status'),
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'goal',
      header: t('mcpConsole.sessions.col.goal', 'Tool / goal'),
      cell: ({ row }) => (
        <span className="text-sm text-foreground">
          {row.original.goal ?? t('mcpConsole.sessions.noGoal', '—')}
        </span>
      ),
    },
    {
      accessorKey: 'toolCallCount',
      header: t('mcpConsole.sessions.col.toolCalls', 'Tool calls'),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.toolCallCount}</span>
      ),
    },
    {
      accessorKey: 'approvalCount',
      header: t('mcpConsole.sessions.col.approvals', 'Approvals'),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.approvalCount}</span>
      ),
    },
    {
      accessorKey: 'startedAt',
      header: t('mcpConsole.sessions.col.started', 'Started'),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{fmtDateTime(row.original.startedAt)}</span>
      ),
    },
    {
      id: 'took',
      header: t('mcpConsole.sessions.col.took', 'Took'),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {fmtSpan(row.original.startedAt, row.original.finishedAt) ??
            t('mcpConsole.sessions.running', 'Running')}
        </span>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('mcpConsole.sessions.title', 'Sessions & audit')}</CardTitle>
        <CardDescription>
          {t(
            'mcpConsole.sessions.desc',
            'Every call a connected client made, newest first. Open a row to see its tool calls and any approval it raised.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataTable
          columns={columns}
          data={items}
          isLoading={q.isLoading}
          loadingRowCount={5}
          onRowClick={(row) => setOpenId(row.id)}
          emptyState={
            <EmptyState
              icon={<ScrollText className="h-10 w-10" />}
              title={t('mcpConsole.sessions.empty', 'No MCP activity yet')}
              description={t(
                'mcpConsole.sessions.emptyHint',
                'Once a connected client calls a tool, the call shows up here with its full audit trail.',
              )}
            />
          }
        />
        {pageCount > 1 && (
          <div className="flex justify-end">
            <Pagination page={page} pageCount={pageCount} onPage={setPage} />
          </div>
        )}
      </CardContent>

      <SessionDetailSheet id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}

/** The audit drawer for one session. */
function SessionDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation('marketing');
  const q = useQuery({
    queryKey: QK.session(id ?? ''),
    queryFn: () => getMcpSession(id as string),
    enabled: !!id,
  });

  return (
    <Sheet
      open={!!id}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('mcpConsole.detail.title', 'Session detail')}</SheetTitle>
          <SheetDescription>
            {t(
              'mcpConsole.detail.privacy',
              'Tool arguments and results are never stored in this view — only their size and the names of the top-level arguments are shown.',
            )}
          </SheetDescription>
        </SheetHeader>

        <QueryStateBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          onRetry={() => q.refetch()}
          errorMessage={t('mcpConsole.detail.loadFailed', 'Could not load this session.')}
          retryLabel={t('common.retry', 'Retry')}
        >
          {q.data && (
            <div className="space-y-5">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t('mcpConsole.sessions.col.status', 'Status')}
                  </dt>
                  <dd className="mt-0.5">
                    <StatusBadge status={q.data.status} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t('mcpConsole.sessions.col.goal', 'Tool / goal')}
                  </dt>
                  <dd className="mt-0.5 break-words text-foreground">{q.data.goal ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t('mcpConsole.sessions.col.started', 'Started')}
                  </dt>
                  <dd className="mt-0.5 text-foreground">{fmtDateTime(q.data.startedAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t('mcpConsole.detail.finished', 'Finished')}
                  </dt>
                  <dd className="mt-0.5 text-foreground">
                    {q.data.finishedAt ? fmtDateTime(q.data.finishedAt) : '—'}
                  </dd>
                </div>
              </dl>

              {q.data.error && (
                <Callout tone="danger" title={t('mcpConsole.detail.errorTitle', 'Session error')}>
                  <span className="break-words">{q.data.error}</span>
                </Callout>
              )}

              {q.data.queuedForApproval && (
                <Callout tone="info" title={t('mcpConsole.detail.gatedTitle', 'Hit the human gate')}>
                  {t(
                    'mcpConsole.detail.gated',
                    'This call was stopped and queued for approval, so it produced no tool-call row of its own.',
                  )}
                </Callout>
              )}

              {/* Tool calls */}
              <section aria-labelledby="mcp-calls-heading" className="space-y-2">
                <h3 id="mcp-calls-heading" className="text-sm font-semibold text-foreground">
                  {t('mcpConsole.detail.toolCalls', 'Tool calls')}
                </h3>
                {q.data.toolCalls.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('mcpConsole.detail.noToolCalls', 'No tool call was recorded for this session.')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {q.data.toolCalls.map((c) => (
                      <li
                        key={c.id}
                        data-testid="mcp-tool-call"
                        className="rounded-lg border border-border bg-surface p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <code className="break-all text-sm text-foreground">{c.tool}</code>
                          <Badge tone={c.ok ? 'success' : 'danger'} size="sm">
                            {c.ok
                              ? t('mcpConsole.detail.ok', 'OK')
                              : t('mcpConsole.detail.failed', 'Failed')}
                          </Badge>
                        </div>
                        <p className="mt-1 text-micro text-muted-foreground">
                          {fmtDateTime(c.at)}
                          {c.latencyMs != null && ` · ${c.latencyMs} ms`}
                        </p>
                        {c.error && <p className="mt-1 break-words text-micro text-danger">{c.error}</p>}
                        <p className="mt-1 text-micro text-muted-foreground">
                          {t('mcpConsole.detail.sizes', 'Arguments {{args}} · result {{result}}', {
                            args: fmtBytes(c.argsBytes),
                            result: fmtBytes(c.resultBytes),
                          })}
                        </p>
                        {c.argsKeys.length > 0 && (
                          <div className="mt-1.5">
                            <p className="text-micro text-muted-foreground">
                              {t('mcpConsole.detail.argKeys', 'Argument names (values not stored):')}
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {c.argsKeys.map((k) => (
                                <Badge key={k} tone="neutral" size="sm">
                                  {k}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Approval requests */}
              <section aria-labelledby="mcp-approvals-heading" className="space-y-2">
                <h3 id="mcp-approvals-heading" className="text-sm font-semibold text-foreground">
                  {t('mcpConsole.detail.approvals', 'Approval requests')}
                </h3>
                {q.data.approvals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('mcpConsole.detail.noApprovals', 'This session asked for no approval.')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {q.data.approvals.map((a) => (
                      <li
                        key={a.id}
                        data-testid="mcp-approval"
                        className="rounded-lg border border-border bg-surface p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 break-words text-sm text-foreground">{a.summary}</p>
                          <Badge tone={approvalTone(a.status)} size="sm">
                            {a.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-micro text-muted-foreground">
                          {a.kind} · {fmtDateTime(a.createdAt)}
                          {a.decidedAt &&
                            ` · ${t('mcpConsole.detail.decided', 'decided')} ${fmtDateTime(a.decidedAt)}`}
                          {!a.decidedAt &&
                            a.expiresAt &&
                            ` · ${t('mcpConsole.detail.expires', 'expires')} ${fmtDateTime(a.expiresAt)}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </QueryStateBoundary>
      </SheetContent>
    </Sheet>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={runTone(status)} size="sm">
      {status}
    </Badge>
  );
}

/** `AgentRun.status` is a free-form string — unknown values stay neutral. */
function runTone(status: string): 'success' | 'danger' | 'info' | 'warning' | 'neutral' {
  const s = (status ?? '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCEEDED' || s === 'COMPLETED' || s === 'DONE') return 'success';
  if (s === 'FAILED' || s === 'ERROR') return 'danger';
  if (s === 'RUNNING' || s === 'STARTED') return 'info';
  if (s === 'PENDING_APPROVAL' || s === 'PENDING') return 'warning';
  return 'neutral';
}

function approvalTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  const s = (status ?? '').toUpperCase();
  if (s === 'APPROVED' || s === 'APPLIED') return 'success';
  if (s === 'REJECTED') return 'danger';
  if (s === 'PENDING') return 'warning';
  return 'neutral';
}

/** Byte sizes, not payloads: the console only ever reports how much data moved. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wall-clock span of a run, or null while it is still open. */
export function fmtSpan(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
