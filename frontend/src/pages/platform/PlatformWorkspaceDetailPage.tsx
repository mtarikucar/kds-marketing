import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi, {
  listPackages,
  assignPackage,
  type PlatformPackage,
  type PackageAssignmentResult,
} from '../../features/platform/api/platformApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
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

/** Subscription lifecycle states (WorkspaceSubscription.status). */
const SUBSCRIPTION_TONE: Record<string, NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  TRIALING: 'info',
  PAST_DUE: 'warning',
  CANCELLED: 'neutral',
  EXPIRED: 'danger',
};

/**
 * The internal grant's period end is the year-2999 sentinel that keeps the
 * hourly billing sweep from ever expiring it (see package-assignment.ts) —
 * printing "31/12/2999" reads as a data bug, so name it for what it is.
 */
const NEVER_EXPIRES_YEAR = 2999;

function formatPeriodEnd(value: string | null | undefined, never: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.getUTCFullYear() >= NEVER_EXPIRES_YEAR ? never : d.toLocaleDateString();
}

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
  // Package picker: the chosen code, whether its confirm dialog is open, and the
  // outcome of the last assignment (kept on screen so `changed:false` can be
  // reported honestly rather than as a toast that implies something happened).
  const [packageCode, setPackageCode] = useState('');
  const [confirmingPackage, setConfirmingPackage] = useState(false);
  const [assignResult, setAssignResult] = useState<PackageAssignmentResult | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  const { data: ws, isLoading } = useQuery({
    queryKey: ['platform', 'workspace', id],
    queryFn: () => platformApi.get(`/workspaces/${id}`).then((r) => r.data),
    // Gate on auth too (guard sits in the layout) so no fetch fires pre-redirect.
    enabled: isAuthenticated && !!id,
  });

  // The operator catalog (NOT marketing's public pricing table — that one hides
  // the internal packages this console grants). Rarely changes; cache it.
  const { data: packages } = useQuery<PlatformPackage[]>({
    queryKey: ['platform', 'packages'],
    queryFn: listPackages,
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
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

  const setPackage = useMutation({
    mutationFn: (code: string) => assignPackage(id!, code),
    onSuccess: (result) => {
      setAssignError(null);
      setAssignResult(result);
      setConfirmingPackage(false);
      // The grant rewrites the subscription row AND the effective entitlements,
      // both of which this page and the workspaces list render.
      queryClient.invalidateQueries({ queryKey: ['platform', 'workspace', id] });
      queryClient.invalidateQueries({ queryKey: ['platform', 'workspaces'] });
      if (result.changed) {
        toast.success(
          t('platform.workspace.package.assigned', {
            defaultValue: 'Now on {{package}}.',
            package: result.packageName,
          }),
        );
      }
      // changed:false gets no success toast — nothing happened. The result
      // panel says so in words instead of faking a confirmation.
    },
    onError: (e: any) => {
      // Render the backend's own message: a 400 lists every valid package code
      // and a 404 says the workspace is gone. Both beat "assignment failed".
      const message =
        e?.response?.data?.message ??
        t('platform.workspace.package.error', {
          defaultValue: 'Could not assign the package.',
        });
      setAssignResult(null);
      setAssignError(Array.isArray(message) ? message.join(' ') : String(message));
      setConfirmingPackage(false);
    },
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
  const subscription = ws.subscription as {
    status: string;
    billingCycle: string;
    currency: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: string | null;
    provider: string | null;
    package: { code: string; name: string; isPublic: boolean } | null;
  } | null;
  const selectedPackage = (packages ?? []).find((p) => p.code === packageCode) ?? null;
  const neverLabel = t('platform.workspace.package.never', {
    defaultValue: 'Never (internal grant)',
  });
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

          <Card>
            <CardHeader>
              <CardTitle>
                {t('platform.workspace.package.title', {
                  defaultValue: 'Subscription / package',
                })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* --- What the workspace is on right now --- */}
              {subscription ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {subscription.package?.name ??
                        t('platform.workspace.package.unknown', {
                          defaultValue: 'Unknown package',
                        })}
                    </span>
                    {subscription.package && (
                      <Badge size="sm" className="font-mono">
                        {subscription.package.code}
                      </Badge>
                    )}
                    <Badge tone={SUBSCRIPTION_TONE[subscription.status] ?? 'neutral'} size="sm">
                      {subscription.status}
                    </Badge>
                    {subscription.package?.isPublic === false && (
                      <Badge tone="warning" size="sm">
                        {t('platform.workspace.package.internalBadge', {
                          defaultValue: 'Internal',
                        })}
                      </Badge>
                    )}
                  </div>
                  <dl className="text-sm">
                    <DefRow
                      label={t('platform.workspace.package.periodEnd', {
                        defaultValue: 'Period ends',
                      })}
                      value={formatPeriodEnd(subscription.currentPeriodEnd, neverLabel)}
                    />
                    {subscription.trialEndsAt && (
                      <DefRow
                        label={t('platform.workspace.package.trialEnds', {
                          defaultValue: 'Trial ends',
                        })}
                        value={new Date(subscription.trialEndsAt).toLocaleDateString()}
                      />
                    )}
                    <DefRow
                      label={t('platform.workspace.package.provider', {
                        defaultValue: 'Billed via',
                      })}
                      value={subscription.provider ?? '—'}
                    />
                  </dl>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('platform.workspace.package.none', {
                    defaultValue:
                      'No subscription — this workspace has never been put on a package.',
                  })}
                </p>
              )}

              {/* --- Change it --- */}
              <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
                <div className="min-w-[15rem] flex-1">
                  <Select
                    value={packageCode}
                    onValueChange={(v) => {
                      setPackageCode(v);
                      // A new pick invalidates the previous outcome — leaving the
                      // old result up would read as if it applied to this package.
                      setAssignResult(null);
                      setAssignError(null);
                    }}
                  >
                    <SelectTrigger
                      aria-label={t('platform.workspace.package.pickerLabel', {
                        defaultValue: 'Package',
                      })}
                    >
                      <SelectValue
                        placeholder={t('platform.workspace.package.pickerPlaceholder', {
                          defaultValue: 'Select a package…',
                        })}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(packages ?? []).map((p) => (
                        <SelectItem key={p.code} value={p.code}>
                          {p.isPublic
                            ? `${p.name} (${p.code})`
                            : t('platform.workspace.package.optionInternal', {
                                defaultValue: '{{name}} ({{code}}) — internal',
                                name: p.name,
                                code: p.code,
                              })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  disabled={!packageCode || setPackage.isPending}
                  onClick={() => setConfirmingPackage(true)}
                >
                  {t('platform.workspace.package.change', { defaultValue: 'Change package' })}
                </Button>
              </div>

              {/* OPERATOR/TRIAL are isPublic:false — an unmetered internal grant,
                  not something a customer ever buys. Say so BEFORE the confirm. */}
              {selectedPackage && !selectedPackage.isPublic && (
                <Callout
                  tone="warning"
                  title={t('platform.workspace.package.internalTitle', {
                    defaultValue: 'Internal package — not a customer tier',
                  })}
                >
                  {t('platform.workspace.package.internalBody', {
                    defaultValue:
                      '{{name}} ({{code}}) is an internal grant (isPublic: false). It is never sold; granting it hands this workspace the internal, effectively unlimited entitlements.',
                    name: selectedPackage.name,
                    code: selectedPackage.code,
                  })}
                </Callout>
              )}

              {/* --- Outcome of the last assignment --- */}
              {assignError && (
                <Callout
                  tone="danger"
                  title={t('platform.workspace.package.failed', {
                    defaultValue: 'Package not assigned',
                  })}
                >
                  {assignError}
                </Callout>
              )}

              {assignResult &&
                (assignResult.changed ? (
                  <Callout
                    tone="success"
                    title={t('platform.workspace.package.successTitle', {
                      defaultValue: 'Package assigned',
                    })}
                  >
                    {t('platform.workspace.package.successBody', {
                      defaultValue:
                        'Now on {{name}} ({{code}}) — {{status}}, period ends {{periodEnd}}.',
                      name: assignResult.packageName,
                      code: assignResult.packageCode,
                      status: assignResult.status,
                      periodEnd: formatPeriodEnd(assignResult.currentPeriodEnd, neverLabel),
                    })}
                  </Callout>
                ) : (
                  <Callout
                    tone="info"
                    title={t('platform.workspace.package.unchangedTitle', {
                      defaultValue: 'Nothing changed',
                    })}
                  >
                    {t('platform.workspace.package.unchangedBody', {
                      defaultValue:
                        'Already on {{name}} ({{code}}) with exactly this grant — nothing changed.',
                      name: assignResult.packageName,
                      code: assignResult.packageCode,
                    })}
                  </Callout>
                ))}
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

      {/* Granting a package rewrites what a paying tenant is entitled to, with
          no money changing hands — name both the workspace and the package, and
          be explicit that this bypasses billing entirely. */}
      <ConfirmDialog
        open={confirmingPackage}
        onOpenChange={(open) => {
          if (!open) setConfirmingPackage(false);
        }}
        title={t('platform.workspace.package.confirm.title', {
          defaultValue: 'Assign package?',
        })}
        description={[
          t('platform.workspace.package.confirm.what', {
            defaultValue: 'Put "{{workspace}}" on {{name}} ({{code}}).',
            workspace: ws.name,
            name: selectedPackage?.name ?? packageCode,
            code: packageCode,
          }),
          selectedPackage && !selectedPackage.isPublic
            ? t('platform.workspace.package.confirm.internal', {
                defaultValue:
                  'This is an INTERNAL package (isPublic: false), not a customer tier — it grants the unlimited internal entitlements.',
              })
            : null,
          t('platform.workspace.package.confirm.noInvoice', {
            defaultValue:
              'A manual grant does not create an invoice and does not create a PSP subscription — nothing will be charged and nothing will auto-renew through the payment provider.',
          }),
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel={t('platform.workspace.package.confirm.cta', {
          defaultValue: 'Assign package',
        })}
        loading={setPackage.isPending}
        onConfirm={() => packageCode && setPackage.mutate(packageCode)}
      />
    </div>
  );
}
