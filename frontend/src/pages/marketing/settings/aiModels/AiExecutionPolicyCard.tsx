import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getAiExecutionPolicy,
  setAiExecutionPolicy,
  type AiExecutionJobPatch,
  type AiExecutionProvider,
} from "@/features/marketing/api/aiExecutionPolicy.service";
import { getMcpConsoleOverview } from "@/features/marketing/api/mcpConsole.service";
import { hasMarketingRole, MarketingRole } from "@/features/marketing/types";
import {
  useMarketingAuthStore,
  type MarketingUser,
} from "@/store/marketingAuthStore";
import type { AiUsageDashboard } from "@/features/marketing/api/aiUsageDashboard.service";
import { Input } from "@/components/ui/Input";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from "@/components/ui/Sheet";
import { AiUsageDetails } from "./AiUsageDetails";
import { usageNumbers, unmeasuredProvider } from "./usagePresentation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { QueryStateBoundary } from "@/components/ui/QueryStateBoundary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";

type UsageProps = { usage?: AiUsageDashboard; usageUnavailable?: boolean };

export function AiExecutionPolicyCard(props: UsageProps) {
  const user = useMarketingAuthStore((state) => state.user);
  // Drafts belong to the active workspace and user, just like the query data.
  return (
    <ExecutionPolicySettings
      key={`${user?.workspaceId}:${user?.id}`}
      user={user}
      {...props}
    />
  );
}

function ExecutionPolicySettings({ user, usage, usageUnavailable = false }: { user: MarketingUser | null } & UsageProps) {
  const { t, i18n } = useTranslation("marketing");
  const { number, money } = usageNumbers(i18n.language);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const titleId = useId();
  const qc = useQueryClient();
  const queryKey = [
    "marketing",
    "ai",
    "execution-policy",
    user?.workspaceId,
    user?.id,
  ];
  const q = useQuery({
    queryKey,
    queryFn: getAiExecutionPolicy,
    enabled: hasMarketingRole(user?.role, MarketingRole.MANAGER),
  });
  const isOwner = user?.role === "OWNER";
  // The console already resolves OWNER + settings.manage on the server.
  // The auth store alone cannot tell whether a custom role grants the scope.
  const permission = useQuery({
    queryKey: [
      "marketing",
      "mcp-console",
      "overview",
      user?.workspaceId,
      user?.id,
    ],
    queryFn: getMcpConsoleOverview,
    enabled: isOwner,
  });
  const canEdit =
    isOwner && !permission.isError && permission.data?.canToggle === true;
  const [draft, setDraft] = useState<Record<string, AiExecutionJobPatch>>({});
  const save = useMutation({
    mutationFn: setAiExecutionPolicy,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey });
    },
    onSuccess: (fresh) => {
      qc.setQueryData(queryKey, fresh);
      setDraft({});
      toast.success(t("aiModels.actions.saved", "AI actions updated."));
    },
  });

  const jobs: Record<string, AiExecutionJobPatch> = {};
  for (const job of q.data?.jobs ?? []) {
    const changes: AiExecutionJobPatch = {};
    const edit = draft[job.id];
    if (edit?.enabled !== undefined && edit.enabled !== job.enabled)
      changes.enabled = edit.enabled;
    if (
      edit?.provider !== undefined &&
      (edit.provider !== job.provider || job.explicit === false)
    )
      changes.provider = edit.provider;
    if (Object.keys(changes).length) jobs[job.id] = changes;
  }
  const disabled = !canEdit || save.isPending;
  const update = (id: string, edit: AiExecutionJobPatch) => {
    if (disabled) return;
    setDraft((previous) => ({
      ...previous,
      [id]: { ...previous[id], ...edit },
    }));
  };
  const providerLabel = (provider: AiExecutionProvider) =>
    provider === "LOCAL" ? t("aiModels.actions.local", "Local") : provider;

  const usageByAction = new Map(usage?.rows.map(row => [row.action, row]));
  const policyIds = new Set(q.data?.jobs.map(job => job.id));
  const rows = [
    ...(q.data?.jobs ?? []).map(job => ({ id: job.id, label: job.label, category: job.category, job, usage: usageByAction.get(job.id) })),
    ...(usage?.rows ?? []).filter(row => !policyIds.has(row.action)).map(row => ({ id: row.action, label: row.label, category: row.category, job: undefined, usage: row })),
  ];
  const categoryLabel = (code: string) => t(`aiModels.usage.categories.${code}`, code);
  const categories = [...new Set(rows.map(row => row.category))];
  const needle = search.trim().toLocaleLowerCase(i18n.language);
  const filtered = rows.filter(row => (!category || row.category === category) &&
    `${row.label} ${row.id} ${row.category} ${categoryLabel(row.category)}`.toLocaleLowerCase(i18n.language).includes(needle));
  const missing = usageUnavailable
    ? t('aiModels.usage.unavailableShort', 'Usage unavailable')
    : t('aiModels.usage.unmeasured', 'Unmeasured / unknown');

  return (
    <section role="region" aria-labelledby={titleId} className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={titleId} className="font-display text-h3">{t("aiModels.actions.title", "AI actions")}</h2>
          <span className="text-caption tabular-nums text-muted-foreground">{filtered.length} / {rows.length}</span>
        </div>
        {canEdit && !!q.data?.jobs.length && <Button size="sm" type="button" loading={save.isPending}
          disabled={disabled || Object.keys(jobs).length === 0}
          onClick={() => { if (!disabled && Object.keys(jobs).length) save.mutate({ jobs }); }}>
          {save.isPending ? t('common.saving', 'Saving…') : t('aiModels.actions.save', 'Save actions')}
        </Button>}
      </div>
      <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}
        errorMessage={t('aiModels.actions.loadFailed', 'AI actions could not be loaded.')} retryLabel={t('common.retry', 'Retry')} className="py-3">
        {q.data && <>
          {!canEdit && !permission.isLoading && !permission.isError && <p className="px-4 pb-2 text-caption text-muted-foreground">{t('aiModels.actions.readOnly', 'Only an owner with settings permission can change AI actions.')}</p>}
          {isOwner && permission.isError && <QueryStateBoundary isError onRetry={() => permission.refetch()}
            errorMessage={t('aiModels.actions.permissionsFailed', 'Edit permissions could not be checked.')} retryLabel={t('common.retry', 'Retry')} className="py-3" />}
          <div className="flex flex-wrap gap-2 px-4 pb-3">
            <Input type="search" aria-label={t('aiModels.usage.search', 'Search actions')} placeholder={t('aiModels.usage.search', 'Search actions')}
              value={search} onChange={event => setSearch(event.target.value)} className="h-8 min-w-36 flex-1" />
            <select aria-label={t('aiModels.usage.category', 'Category')} value={category} onChange={event => setCategory(event.target.value)} disabled={save.isPending}
              className="h-8 max-w-52 rounded-lg border border-border-strong bg-surface px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">{t('aiModels.usage.allCategories', 'All categories')}</option>
              {categories.map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}
            </select>
          </div>
          {/* Anchor Radix hidden inputs and sr-only text inside the scrolling region. */}
          <div role="region" aria-label={t('aiModels.usage.tableScroll', 'Scrollable action table')} tabIndex={0}
            className="relative max-h-[clamp(10rem,calc(100dvh-37rem),28rem)] overflow-auto border-y border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <table aria-label={t('aiModels.usage.table', 'AI action usage and settings')} className="w-full min-w-[740px] border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10 bg-surface-muted text-caption text-muted-foreground">
                <tr>{[
                  t('aiModels.usage.action', 'Action / category'), t('aiModels.usage.provider', 'Provider'), t('aiModels.usage.active', 'Active'),
                  t('aiModels.usage.calls', 'Calls / jobs'), t('aiModels.usage.measuredTokens', 'API tokens'), t('aiModels.usage.estimatedCost', 'Estimated USD'),
                ].map((label, index) => <th key={label} scope="col" className={`border-b border-border px-3 py-2 font-medium ${index > 2 ? 'text-end' : 'text-start'}`}>{label}</th>)}</tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const { job } = row;
                  const provider = job ? draft[job.id]?.provider ?? job.provider : undefined;
                  const unmeasured = unmeasuredProvider(row.usage, provider);
                  const measured = unmeasured ? undefined : row.usage;
                  return <tr key={row.id} className="group hover:bg-surface-muted">
                    <th scope="row" className="border-b border-border px-3 py-2 text-start font-normal">
                      <Sheet>
                        <SheetTrigger asChild><button type="button" aria-label={t('aiModels.usage.details', '{{label}}: details', { label: row.label })}
                          className="block max-w-72 rounded text-start font-medium text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{row.label}</button></SheetTrigger>
                        <SheetContent hideClose className="w-full max-w-lg overflow-y-auto">
                          <SheetHeader><SheetTitle>{row.label}</SheetTitle><SheetDescription>{job?.description ?? t('aiModels.usage.historicalHint', 'Historical usage. This action is no longer configurable.')}</SheetDescription></SheetHeader>
                          <SheetClose asChild><Button variant="outline" size="sm" className="self-end">{t('common.close', 'Close')}</Button></SheetClose>
                          <AiUsageDetails row={row.usage} unmeasured={unmeasured} unavailable={usageUnavailable} />
                        </SheetContent>
                      </Sheet>
                      <span className="text-caption text-muted-foreground">{categoryLabel(row.category)}</span>
                    </th>
                    <td className="border-b border-border px-3 py-2">
                      {job ? <Select value={job.explicit === false && draft[job.id]?.provider === undefined ? 'INHERITED' : provider}
                        onValueChange={value => update(job.id, { provider: value as AiExecutionProvider })} disabled={disabled}>
                        <SelectTrigger className="h-8 w-40" aria-label={t('aiModels.actions.providerLabel', '{{label}}: provider', { label: job.label })}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {job.explicit === false && <SelectItem value="INHERITED" disabled>{t('aiModels.actions.inherited', 'Current rule: {{provider}}', { provider: providerLabel(job.provider) })}</SelectItem>}
                          {job.providers.map(option => <SelectItem key={option} value={option}>{job.availability[option] ? providerLabel(option) : t('aiModels.actions.notReady', '{{provider}} · Not ready', { provider: providerLabel(option) })}</SelectItem>)}
                        </SelectContent>
                      </Select> : <span className="text-caption text-muted-foreground">{t('aiModels.usage.historical', 'Historical · read only')}</span>}
                    </td>
                    <td className="border-b border-border px-3 py-2">{job ? <Switch checked={draft[job.id]?.enabled ?? job.enabled}
                      onCheckedChange={enabled => update(job.id, { enabled })} disabled={disabled} aria-label={t('aiModels.actions.activeLabel', '{{label}}: active', { label: job.label })} /> : '—'}</td>
                    {[number(measured?.calls), number(measured?.tokens), money(measured?.costUsd)].map((value, index) => <td key={index} className="whitespace-nowrap border-b border-border px-3 py-2 text-end tabular-nums" title={value === '—' ? missing : undefined}>
                      {value}{value === '—' && <span className="sr-only"> {missing}</span>}
                      {index === 2 && measured?.costUsd != null && measured.unpricedCalls > 0 && <span className="ms-1 text-caption text-muted-foreground" title={t('aiModels.usage.partial', 'Partial estimate')}>*</span>}
                    </td>)}
                  </tr>;
                })}
                {!filtered.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">{rows.length ? t('aiModels.usage.noResults', 'No matching actions. Clear the filters to see all actions.') : t('aiModels.actions.empty', 'No AI actions available.')}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-2 text-caption text-muted-foreground">
            <p>{t('aiModels.usage.dashHint', '— Unmeasured / unknown · USD estimates, not billing credits')}{usageUnavailable && ` · ${t('aiModels.usage.unavailableShort', 'Usage unavailable')}`}</p>
            <details className="min-w-0 flex-1">
              <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('aiModels.usage.providers', 'Providers and fees')}</summary>
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Badge tone={q.data.mcp.connected ? 'success' : 'neutral'} size="sm">{q.data.mcp.connected ? t('aiModels.actions.mcpConnected', 'Recent MCP activity') : t('aiModels.actions.mcpDisconnected', 'No recent MCP activity')}</Badge>
                  <Badge tone={q.data.local.configured ? 'success' : 'neutral'} size="sm">{q.data.local.configured ? t('aiModels.actions.localConfigured', 'Local hosting configured') : t('aiModels.actions.localUnconfigured', 'Local hosting not configured')}</Badge>
                </div>
                <p>{t('aiModels.actions.mcpHint', 'MCP uses your own Claude account as the connected agent to pull work from Jeeta; client quota and costs may apply.')}</p>
                <p>{t('aiModels.actions.waitHint', 'Without a connected Claude client, MCP jobs wait; there is no paid LLM fallback.')}</p>
                <p>{t('aiModels.actions.localHint', 'Local models avoid vendor per-call fees but need hosting.')}</p>
                <p>{t('aiModels.actions.mediaHint', 'fal and media services charge separate external fees, even when Claude orchestrates.')}</p>
              </div>
            </details>
          </div>
          {save.isError && <Callout tone="danger" className="mx-4 mb-3">{t('aiModels.actions.saveFailed', 'AI actions could not be saved. Your edits are kept; try again.')}</Callout>}
        </>}
      </QueryStateBoundary>
    </section>
  );
}
