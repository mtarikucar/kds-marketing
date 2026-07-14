import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useTranslation } from 'react-i18next';
import type { BreadcrumbItem } from '@/components/ui/Breadcrumbs';

/** SPA-nav render helper for breadcrumbs — avoids full page reload. */
function renderBreadcrumbLink(item: BreadcrumbItem, _children: React.ReactNode) {
  return (
    <Link to={item.href!} className="text-muted-foreground hover:text-foreground transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring] rounded">
      {item.label}
    </Link>
  );
}

const STATUS_TONE: Record<string, NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'neutral',
};

type WorkspaceKind = 'STANDALONE' | 'AGENCY' | 'LOCATION';

const KIND_TONE: Record<WorkspaceKind, NonNullable<BadgeProps['tone']>> = {
  AGENCY: 'primary',
  STANDALONE: 'neutral',
  LOCATION: 'info',
};

function DefRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end text-foreground">{value}</dd>
    </div>
  );
}

export default function PlatformWorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = usePlatformAuthStore();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Which tier change the operator is confirming, or null when the dialog is closed.
  const [tierTarget, setTierTarget] = useState<WorkspaceKind | null>(null);

  const { data: ws, isLoading } = useQuery({
    queryKey: ['platform', 'workspace', id],
    queryFn: () => platformApi.get(`/workspaces/${id}`).then((r) => r.data),
    // Gate on auth too (guard sits in the layout) so no fetch fires pre-redirect.
    enabled: isAuthenticated && !!id,
  });

  const setTier = useMutation({
    mutationFn: (kind: WorkspaceKind) =>
      platformApi.patch(`/workspaces/${id}`, { kind }).then((r) => r.data),
    onSuccess: (_data, kind) => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'workspace', id] });
      toast.success(
        kind === 'AGENCY'
          ? t('platform.workspace.tier.promoted', {
              defaultValue: 'Promoted to agency — the agency console is now unlocked.',
            })
          : t('platform.workspace.tier.reverted', {
              defaultValue: 'Reverted to a standalone workspace.',
            }),
      );
      setTierTarget(null);
    },
    onError: (e: any) =>
      toast.error(
        e.response?.data?.message ??
          t('platform.workspace.tier.error', { defaultValue: 'Could not change the tier.' }),
      ),
  });

  const breadcrumbs = [
    { label: 'Workspaces', href: '/platform/workspaces' },
    { label: ws?.name ?? 'Workspace' },
  ];

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!ws) {
    return (
      <div className="space-y-5">
        <PageHeader title="Workspace" breadcrumbs={breadcrumbs} renderBreadcrumbLink={renderBreadcrumbLink} />
        <EmptyState title="Not found" description="This workspace does not exist or is no longer available." />
      </div>
    );
  }

  const kind = ws.kind as WorkspaceKind;
  const kindLabel =
    kind === 'AGENCY'
      ? t('platform.workspace.tier.agency', { defaultValue: 'Agency' })
      : kind === 'LOCATION'
        ? t('platform.workspace.tier.location', { defaultValue: 'Sub-account' })
        : t('platform.workspace.tier.standalone', { defaultValue: 'Standalone' });

  return (
    <div className="space-y-6">
      <PageHeader
        title={ws.name}
        breadcrumbs={breadcrumbs}
        renderBreadcrumbLink={renderBreadcrumbLink}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={KIND_TONE[ws.kind as WorkspaceKind] ?? 'neutral'}>{kindLabel}</Badge>
            <Badge tone={STATUS_TONE[ws.status] ?? 'neutral'}>{ws.status}</Badge>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Users" value={String(ws.counts.users)} />
        <StatCard label="Leads" value={String(ws.counts.leads)} />
        <StatCard label="Open leads" value={String(ws.counts.openLeads)} />
        <StatCard label="Won leads" value={String(ws.counts.wonLeads)} tone="success" />
      </div>

      <Tabs defaultValue="workspace">
        <TabsList>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="owner">Owner</TabsTrigger>
          {ws.productDescription && <TabsTrigger value="product">Product</TabsTrigger>}
        </TabsList>

        <TabsContent value="workspace" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Workspace details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="text-sm">
                <DefRow label="Slug" value={<span className="font-mono">{ws.slug}</span>} />
                <DefRow label="Product" value={ws.productName} />
                <DefRow label="URL" value={ws.productUrl ?? '—'} />
                <DefRow
                  label="Language / Currency"
                  value={`${ws.defaultLanguage} / ${ws.defaultCurrency}`}
                />
                <DefRow label="Core integration" value={ws.coreIntegration ? 'Yes' : 'No'} />
                <DefRow label="Created" value={new Date(ws.createdAt).toLocaleDateString()} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('platform.workspace.tier.title', { defaultValue: 'Plan tier' })}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={KIND_TONE[kind] ?? 'neutral'}>{kindLabel}</Badge>
                  </div>
                  <p className="max-w-prose text-sm text-muted-foreground">
                    {kind === 'AGENCY'
                      ? t('platform.workspace.tier.helper.agency', {
                          defaultValue:
                            'This workspace is an agency: its owner can create sub-accounts, apply snapshots, rebill, and switch into any sub-account.',
                        })
                      : kind === 'LOCATION'
                        ? t('platform.workspace.tier.helper.location', {
                            defaultValue:
                              'This is a sub-account owned by an agency. Its tier is managed from the parent agency — move or remove it there.',
                          })
                        : t('platform.workspace.tier.helper.standalone', {
                            defaultValue:
                              'Promoting to an agency unlocks the agency console: sub-accounts, snapshots, rebilling, and switch-into-sub-account.',
                          })}
                  </p>
                </div>

                {kind === 'STANDALONE' && (
                  <Button
                    size="sm"
                    disabled={setTier.isPending}
                    onClick={() => setTierTarget('AGENCY')}
                  >
                    {t('platform.workspace.tier.promote', { defaultValue: 'Promote to agency' })}
                  </Button>
                )}
                {kind === 'AGENCY' && (
                  <div className="flex flex-col items-start gap-1.5">
                    {(ws.locationCount ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {t('platform.workspace.tier.subAccounts', {
                          defaultValue:
                            '{{count}} sub-account(s) — move or remove them before you can revert.',
                          count: ws.locationCount,
                        })}
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={setTier.isPending || (ws.locationCount ?? 0) > 0}
                      onClick={() => setTierTarget('STANDALONE')}
                    >
                      {t('platform.workspace.tier.revert', { defaultValue: 'Revert to standalone' })}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="owner">
          <Card>
            <CardHeader>
              <CardTitle>Owner</CardTitle>
            </CardHeader>
            <CardContent>
              {ws.owner ? (
                <dl className="text-sm">
                  <DefRow label="Name" value={`${ws.owner.firstName} ${ws.owner.lastName}`} />
                  <DefRow label="Email" value={ws.owner.email} />
                  <DefRow
                    label="Last login"
                    value={ws.owner.lastLogin ? new Date(ws.owner.lastLogin).toLocaleString() : '—'}
                  />
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">No owner account</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {ws.productDescription && (
          <TabsContent value="product">
            <Card>
              <CardHeader>
                <CardTitle>Product description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {ws.productDescription}
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Tier change is a structural change (unlocks/locks the agency console) — confirm it. */}
      <ConfirmDialog
        open={tierTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTierTarget(null);
        }}
        title={
          tierTarget === 'AGENCY'
            ? t('platform.workspace.tier.promoteConfirm.title', { defaultValue: 'Promote to agency?' })
            : t('platform.workspace.tier.revertConfirm.title', { defaultValue: 'Revert to standalone?' })
        }
        description={
          tierTarget === 'AGENCY'
            ? t('platform.workspace.tier.promoteConfirm.body', {
                defaultValue:
                  '"{{name}}" becomes an agency and unlocks the agency console (sub-accounts, snapshots, rebilling, switch-into-sub-account).',
                name: ws.name,
              })
            : t('platform.workspace.tier.revertConfirm.body', {
                defaultValue:
                  '"{{name}}" reverts to a standalone workspace and loses agency features. It must have no sub-accounts.',
                name: ws.name,
              })
        }
        confirmLabel={
          tierTarget === 'AGENCY'
            ? t('platform.workspace.tier.promote', { defaultValue: 'Promote to agency' })
            : t('platform.workspace.tier.revert', { defaultValue: 'Revert to standalone' })
        }
        tone={tierTarget === 'STANDALONE' ? 'danger' : 'default'}
        loading={setTier.isPending}
        onConfirm={() => tierTarget && setTier.mutate(tierTarget)}
      />
    </div>
  );
}
