import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatCard } from '@/components/ui/StatCard';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

const STATUS_TONE: Record<string, NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'neutral',
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

  const { data: ws, isLoading } = useQuery({
    queryKey: ['platform', 'workspace', id],
    queryFn: () => platformApi.get(`/workspaces/${id}`).then((r) => r.data),
    // Gate on auth too (guard sits in the layout) so no fetch fires pre-redirect.
    enabled: isAuthenticated && !!id,
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
        <PageHeader title="Workspace" breadcrumbs={breadcrumbs} />
        <EmptyState title="Not found" description="This workspace does not exist or is no longer available." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={ws.name}
        breadcrumbs={breadcrumbs}
        actions={
          <Badge tone={STATUS_TONE[ws.status] ?? 'neutral'}>{ws.status}</Badge>
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

        <TabsContent value="workspace">
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
    </div>
  );
}
