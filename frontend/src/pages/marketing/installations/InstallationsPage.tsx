import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import type {
  InstallationJob,
  InstallationCrew,
  InstallationDashboard,
  Lead,
  PaginatedResponse,
} from '../../../features/marketing/types';
import { PageHeader, Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui';
import { DashboardTab } from './DashboardTab';
import { JobsTab } from './JobsTab';
import { CrewsTab } from './CrewsTab';
import { JobDrawer } from './JobDrawer';

export default function InstallationsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();

  const invalidateAll = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'installations'] });

  // Jobs filters + pagination
  const [status, setStatus] = useState('');
  const [crewIdFilter, setCrewIdFilter] = useState('');
  const [page, setPage] = useState(1);

  // Selected job for side drawer
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: dashboard } = useQuery<InstallationDashboard>({
    queryKey: ['marketing', 'installations', 'dashboard'],
    queryFn: () => marketingApi.get('/installations/dashboard').then((r) => r.data),
  });

  const { data: crews = [] } = useQuery<InstallationCrew[]>({
    queryKey: ['marketing', 'installations', 'crews'],
    queryFn: () => marketingApi.get('/installations/crews').then((r) => r.data),
  });

  const { data: jobsData, isLoading: jobsLoading } = useQuery<PaginatedResponse<InstallationJob>>({
    queryKey: ['marketing', 'installations', 'jobs', { status, crewIdFilter, page }],
    queryFn: () =>
      marketingApi
        .get('/installations/jobs', {
          params: {
            status: status || undefined,
            crewId: crewIdFilter || undefined,
            page,
            limit: 20,
          },
        })
        .then((r) => r.data),
  });

  const { data: leadsData } = useQuery<PaginatedResponse<Lead>>({
    queryKey: ['marketing', 'leads', 'converted'],
    queryFn: () =>
      marketingApi.get('/leads', { params: { limit: 100 } }).then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });
  const convertedLeads = (leadsData?.data || []).filter((l) => l.convertedTenantId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Installation Ops"
        description="Manage installation jobs, crews and scheduling."
      />

      <Tabs defaultValue="dashboard">
        <TabsList>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="crews">Crews</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard">
          <DashboardTab dashboard={dashboard} onJobClick={setSelectedJobId} />
        </TabsContent>

        <TabsContent value="jobs">
          <JobsTab
            isManager={isManager}
            crews={crews}
            jobsData={jobsData}
            jobsLoading={jobsLoading}
            status={status}
            setStatus={setStatus}
            crewIdFilter={crewIdFilter}
            setCrewIdFilter={setCrewIdFilter}
            page={page}
            setPage={setPage}
            convertedLeads={convertedLeads}
            onJobClick={setSelectedJobId}
            onInvalidate={invalidateAll}
          />
        </TabsContent>

        <TabsContent value="crews">
          <CrewsTab
            isManager={isManager}
            crews={crews}
            onInvalidate={invalidateAll}
          />
        </TabsContent>
      </Tabs>

      {/* Job detail side drawer */}
      <JobDrawer
        jobId={selectedJobId}
        crews={crews}
        onClose={() => setSelectedJobId(null)}
        onChanged={invalidateAll}
      />
    </div>
  );
}
