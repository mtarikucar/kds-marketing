import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getAiExecutionPolicy,
  setAiExecutionPolicy,
  type AiExecutionJob,
  type AiExecutionJobPatch,
  type AiExecutionProvider,
} from "@/features/marketing/api/aiExecutionPolicy.service";
import { getMcpConsoleOverview } from "@/features/marketing/api/mcpConsole.service";
import { hasMarketingRole, MarketingRole } from "@/features/marketing/types";
import {
  useMarketingAuthStore,
  type MarketingUser,
} from "@/store/marketingAuthStore";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { QueryStateBoundary } from "@/components/ui/QueryStateBoundary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";

export function AiExecutionPolicyCard() {
  const user = useMarketingAuthStore((state) => state.user);
  // Drafts belong to the active workspace and user, just like the query data.
  return (
    <ExecutionPolicySettings
      key={`${user?.workspaceId}:${user?.id}`}
      user={user}
    />
  );
}

function ExecutionPolicySettings({ user }: { user: MarketingUser | null }) {
  const { t } = useTranslation("marketing");
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
  const categories = new Map<string, AiExecutionJob[]>();
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
    const group = categories.get(job.category) ?? [];
    group.push(job);
    categories.set(job.category, group);
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

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId}>
          {t("aiModels.actions.title", "AI actions")}
        </CardTitle>
        <CardDescription>
          {t(
            "aiModels.actions.description",
            "Choose which actions run and who runs them.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1 text-caption text-muted-foreground">
          <p>
            {t(
              "aiModels.actions.mcpHint",
              "MCP uses your own Claude account as the connected agent to pull work from Jeeta; client quota and costs may apply.",
            )}
          </p>
          <p>
            {t(
              "aiModels.actions.waitHint",
              "Without a connected Claude client, MCP jobs wait; there is no paid LLM fallback.",
            )}
          </p>
          <p>
            {t(
              "aiModels.actions.localHint",
              "Local models avoid vendor per-call fees but need hosting.",
            )}
          </p>
          <p>
            {t(
              "aiModels.actions.mediaHint",
              "fal and media services charge separate external fees, even when Claude orchestrates.",
            )}
          </p>
        </div>

        <QueryStateBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          onRetry={() => q.refetch()}
          errorMessage={t(
            "aiModels.actions.loadFailed",
            "AI actions could not be loaded.",
          )}
          retryLabel={t("common.retry", "Retry")}
        >
          {q.data && (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge
                  tone={q.data.mcp.connected ? "success" : "neutral"}
                  size="sm"
                >
                  {q.data.mcp.connected
                    ? t("aiModels.actions.mcpConnected", "Recent MCP activity")
                    : t(
                        "aiModels.actions.mcpDisconnected",
                        "No recent MCP activity",
                      )}
                </Badge>
                <Badge
                  tone={q.data.local.configured ? "success" : "neutral"}
                  size="sm"
                >
                  {q.data.local.configured
                    ? t(
                        "aiModels.actions.localConfigured",
                        "Local hosting configured",
                      )
                    : t(
                        "aiModels.actions.localUnconfigured",
                        "Local hosting not configured",
                      )}
                </Badge>
              </div>

              {!canEdit && !permission.isLoading && !permission.isError && (
                <p className="text-caption text-muted-foreground">
                  {t(
                    "aiModels.actions.readOnly",
                    "Only an owner with settings permission can change AI actions.",
                  )}
                </p>
              )}
              {isOwner && permission.isError && (
                <QueryStateBoundary
                  isError
                  onRetry={() => permission.refetch()}
                  errorMessage={t(
                    "aiModels.actions.permissionsFailed",
                    "Edit permissions could not be checked.",
                  )}
                  retryLabel={t("common.retry", "Retry")}
                />
              )}

              {q.data.jobs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("aiModels.actions.empty", "No AI actions available.")}
                </p>
              )}
              <div className="divide-y divide-border">
                {[...categories].map(([category, categoryJobs]) => (
                  <details key={category} open className="py-2">
                    <summary className="cursor-pointer rounded py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {category}{" "}
                      <span className="text-muted-foreground">
                        ({categoryJobs.length})
                      </span>
                    </summary>
                    <div className="divide-y divide-border">
                      {categoryJobs.map((job) => {
                        const provider =
                          draft[job.id]?.provider ?? job.provider;
                        const descriptionId = `${titleId}-${job.id}-description`;
                        return (
                          <div
                            key={job.id}
                            className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap"
                          >
                            <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                              <p className="text-sm font-medium">{job.label}</p>
                              <p
                                id={descriptionId}
                                className="text-caption text-muted-foreground"
                              >
                                {job.description}
                              </p>
                            </div>
                            <Select
                              value={
                                job.explicit === false &&
                                draft[job.id]?.provider === undefined
                                  ? "INHERITED"
                                  : provider
                              }
                              onValueChange={(value) =>
                                update(job.id, {
                                  provider: value as AiExecutionProvider,
                                })
                              }
                              disabled={disabled}
                            >
                              <SelectTrigger
                                className="w-44 shrink-0"
                                aria-label={t(
                                  "aiModels.actions.providerLabel",
                                  "{{label}}: provider",
                                  { label: job.label },
                                )}
                                aria-describedby={descriptionId}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {job.explicit === false && (
                                  <SelectItem value="INHERITED" disabled>
                                    {t(
                                      "aiModels.actions.inherited",
                                      "Current rule: {{provider}}",
                                      { provider: providerLabel(job.provider) },
                                    )}
                                  </SelectItem>
                                )}
                                {job.providers.map((option) => (
                                  <SelectItem key={option} value={option}>
                                    {job.availability[option]
                                      ? providerLabel(option)
                                      : t(
                                          "aiModels.actions.notReady",
                                          "{{provider}} · Not ready",
                                          { provider: providerLabel(option) },
                                        )}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Switch
                              checked={draft[job.id]?.enabled ?? job.enabled}
                              onCheckedChange={(enabled) =>
                                update(job.id, { enabled })
                              }
                              disabled={disabled}
                              aria-label={t(
                                "aiModels.actions.activeLabel",
                                "{{label}}: active",
                                { label: job.label },
                              )}
                              aria-describedby={descriptionId}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ))}
              </div>
              {save.isError && (
                <Callout tone="danger">
                  {t(
                    "aiModels.actions.saveFailed",
                    "AI actions could not be saved. Your edits are kept; try again.",
                  )}
                </Callout>
              )}
              {canEdit && q.data.jobs.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    loading={save.isPending}
                    disabled={disabled || Object.keys(jobs).length === 0}
                    onClick={() => {
                      if (!disabled && Object.keys(jobs).length)
                        save.mutate({ jobs });
                    }}
                  >
                    {save.isPending
                      ? t("common.saving", "Saving…")
                      : t("aiModels.actions.save", "Save actions")}
                  </Button>
                </div>
              )}
            </>
          )}
        </QueryStateBoundary>
      </CardContent>
    </Card>
  );
}
