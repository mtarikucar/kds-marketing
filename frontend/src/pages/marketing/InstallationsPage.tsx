import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, XMarkIcon, TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import {
  InstallationStatus,
  INSTALLATION_STATUS_LABELS,
  INSTALLATION_TRANSITIONS,
} from '../../features/marketing/types';
import type {
  InstallationJob,
  InstallationCrew,
  InstallationDashboard,
  Lead,
  PaginatedResponse,
} from '../../features/marketing/types';
import { INSTALLATION_STATUS_BADGE } from '../../features/marketing/constants';
import { fmtDate } from '../../features/marketing/utils/format';

const STATUSES = Object.values(InstallationStatus);
const WINDOWS = ['MORNING', 'AFTERNOON', 'FULL_DAY'] as const;

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
        INSTALLATION_STATUS_BADGE[status] || 'bg-gray-100 text-gray-800'
      }`}
    >
      {INSTALLATION_STATUS_LABELS[status as InstallationStatus] || status}
    </span>
  );
}

const errMsg = (err: any, fallback: string) => err?.response?.data?.message || fallback;

export default function InstallationsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();
  const invalidateAll = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'installations'] });

  const [tab, setTab] = useState<'dashboard' | 'jobs' | 'crews'>('dashboard');

  // Jobs filters + drawer
  const [status, setStatus] = useState('');
  const [crewIdFilter, setCrewIdFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // Job create form (manager)
  const [showJobForm, setShowJobForm] = useState(false);
  const [jobForm, setJobForm] = useState({
    leadId: '',
    siteAddress: '',
    siteCity: '',
    contactName: '',
    contactPhone: '',
    notes: '',
  });

  // Crew create/edit (manager)
  const [showCrewForm, setShowCrewForm] = useState(false);
  const [crewForm, setCrewForm] = useState({ name: '', dailyCapacity: '', notes: '' });
  const [editingCrewId, setEditingCrewId] = useState<string | null>(null);
  const [editCrewForm, setEditCrewForm] = useState({
    name: '',
    active: true,
    dailyCapacity: '',
    notes: '',
  });

  // ---- Queries ----
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
    queryFn: () => marketingApi.get('/leads', { params: { limit: 100 } }).then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });
  const convertedLeads = (leadsData?.data || []).filter((l) => l.convertedTenantId);

  // ---- Mutations ----
  const createJob = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/installations/jobs', payload),
    onSuccess: () => {
      toast.success('Installation job created');
      invalidateAll();
      setShowJobForm(false);
      setJobForm({ leadId: '', siteAddress: '', siteCity: '', contactName: '', contactPhone: '', notes: '' });
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to create job')),
  });

  const createCrew = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/installations/crews', payload),
    onSuccess: () => {
      toast.success('Crew created');
      invalidateAll();
      setShowCrewForm(false);
      setCrewForm({ name: '', dailyCapacity: '', notes: '' });
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to create crew')),
  });

  const updateCrew = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      marketingApi.patch(`/installations/crews/${id}`, payload),
    onSuccess: () => {
      toast.success('Crew updated');
      invalidateAll();
      setEditingCrewId(null);
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to update crew')),
  });

  function submitJob() {
    const lead = convertedLeads.find((l) => l.id === jobForm.leadId);
    if (!lead?.convertedTenantId) {
      toast.error('Select a converted lead');
      return;
    }
    createJob.mutate({
      tenantId: lead.convertedTenantId,
      leadId: lead.id,
      siteAddress: jobForm.siteAddress || undefined,
      siteCity: jobForm.siteCity || undefined,
      contactName: jobForm.contactName || undefined,
      contactPhone: jobForm.contactPhone || undefined,
      notes: jobForm.notes || undefined,
    });
  }

  function startEditCrew(c: InstallationCrew) {
    setEditingCrewId(c.id);
    setEditCrewForm({
      name: c.name,
      active: c.active,
      dailyCapacity: String(c.dailyCapacity),
      notes: c.notes || '',
    });
  }

  const meta = jobsData?.meta;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Installation Ops</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {(['dashboard', 'jobs', 'crews'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md capitalize ${
              tab === t ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ===== Dashboard tab ===== */}
      {tab === 'dashboard' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {STATUSES.map((s) => (
              <div key={s} className="bg-white rounded-xl border border-gray-200 p-5">
                <p className="text-sm text-gray-500">{INSTALLATION_STATUS_LABELS[s]}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{dashboard?.byStatus?.[s] ?? 0}</p>
              </div>
            ))}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <p className="text-sm text-gray-500">Unscheduled</p>
              <p className={`text-2xl font-bold mt-1 ${dashboard && dashboard.unscheduled > 0 ? 'text-yellow-600' : 'text-green-600'}`}>
                {dashboard?.unscheduled ?? 0}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <p className="text-sm text-gray-500">Overdue SLA</p>
              <p className={`text-2xl font-bold mt-1 ${dashboard && dashboard.overdueSla > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {dashboard?.overdueSla ?? 0}
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b text-sm font-semibold text-gray-700">Upcoming (next 7 days)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-gray-500">
                    <th className="px-4 py-3 font-medium">Contact / Site</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Scheduled</th>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Window</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(dashboard?.upcoming || []).length === 0 ? (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-500">No upcoming jobs</td></tr>
                  ) : (
                    dashboard!.upcoming.map((j) => (
                      <tr key={j.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedJobId(j.id)}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{j.contactName || '—'}</p>
                          <p className="text-xs text-gray-400">{j.siteCity || j.siteAddress || ''}</p>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={j.status} /></td>
                        <td className="px-4 py-3 hidden md:table-cell text-gray-600">{j.scheduledDate ? fmtDate(j.scheduledDate) : '—'}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-gray-600">{j.scheduledWindow || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===== Jobs tab ===== */}
      {tab === 'jobs' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <select
                value={status}
                onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">All statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{INSTALLATION_STATUS_LABELS[s]}</option>)}
              </select>
              <select
                value={crewIdFilter}
                onChange={(e) => { setCrewIdFilter(e.target.value); setPage(1); }}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="">All crews</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {(status || crewIdFilter) && (
                <button onClick={() => { setStatus(''); setCrewIdFilter(''); setPage(1); }} className="text-xs text-primary hover:underline">Clear</button>
              )}
            </div>
            {isManager && (
              <button onClick={() => setShowJobForm(!showJobForm)} className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90">
                <PlusIcon className="w-4 h-4" /> New Job
              </button>
            )}
          </div>

          {showJobForm && isManager && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
              <h2 className="text-sm font-semibold text-gray-700">Create job from a converted customer</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <select value={jobForm.leadId} onChange={(e) => setJobForm({ ...jobForm, leadId: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                  <option value="">Select converted customer…</option>
                  {convertedLeads.map((l) => <option key={l.id} value={l.id}>{l.businessName}</option>)}
                </select>
                <input placeholder="Contact name" value={jobForm.contactName} onChange={(e) => setJobForm({ ...jobForm, contactName: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <input placeholder="Contact phone" value={jobForm.contactPhone} onChange={(e) => setJobForm({ ...jobForm, contactPhone: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <input placeholder="Site city" value={jobForm.siteCity} onChange={(e) => setJobForm({ ...jobForm, siteCity: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <input placeholder="Site address" value={jobForm.siteAddress} onChange={(e) => setJobForm({ ...jobForm, siteAddress: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm sm:col-span-2" />
                <textarea placeholder="Notes" value={jobForm.notes} onChange={(e) => setJobForm({ ...jobForm, notes: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none sm:col-span-2 lg:col-span-3" rows={2} />
              </div>
              <div className="flex gap-2">
                <button onClick={submitJob} disabled={!jobForm.leadId || createJob.isPending} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {createJob.isPending ? 'Creating…' : 'Create'}
                </button>
                <button onClick={() => setShowJobForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600">Cancel</button>
              </div>
              {convertedLeads.length === 0 && <p className="text-xs text-gray-400">No converted customers yet — jobs are created for leads that have a tenant.</p>}
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-gray-500">
                    <th className="px-4 py-3 font-medium">Contact / Site</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Crew</th>
                    <th className="px-4 py-3 font-medium hidden md:table-cell">Scheduled</th>
                    <th className="px-4 py-3 font-medium hidden lg:table-cell">Requested</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {jobsLoading ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">Loading…</td></tr>
                  ) : (jobsData?.data || []).length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No jobs found</td></tr>
                  ) : (
                    jobsData!.data.map((j) => (
                      <tr key={j.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedJobId(j.id)}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{j.contactName || '—'}</p>
                          <p className="text-xs text-gray-400">{j.siteCity || j.siteAddress || ''}</p>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={j.status} /></td>
                        <td className="px-4 py-3 hidden md:table-cell text-gray-600">{crews.find((c) => c.id === j.crewId)?.name || '—'}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-gray-600">{j.scheduledDate ? fmtDate(j.scheduledDate) : '—'}</td>
                        <td className="px-4 py-3 hidden lg:table-cell text-gray-400 text-xs">{fmtDate(j.requestedAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {meta && meta.totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-sm text-gray-500">{(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} / {meta.total}</p>
                <div className="flex gap-2">
                  <button onClick={() => setPage(page - 1)} disabled={page === 1} className="px-3 py-1 border rounded text-sm disabled:opacity-50">Previous</button>
                  <button onClick={() => setPage(page + 1)} disabled={page >= meta.totalPages} className="px-3 py-1 border rounded text-sm disabled:opacity-50">Next</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Crews tab ===== */}
      {tab === 'crews' && (
        <div className="space-y-4">
          {isManager && (
            <div className="flex justify-end">
              <button onClick={() => setShowCrewForm(!showCrewForm)} className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90">
                <PlusIcon className="w-4 h-4" /> Add Crew
              </button>
            </div>
          )}
          {showCrewForm && isManager && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input placeholder="Crew name" value={crewForm.name} onChange={(e) => setCrewForm({ ...crewForm, name: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <input type="number" min={1} max={20} placeholder="Daily capacity" value={crewForm.dailyCapacity} onChange={(e) => setCrewForm({ ...crewForm, dailyCapacity: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <input placeholder="Notes" value={crewForm.notes} onChange={(e) => setCrewForm({ ...crewForm, notes: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (!crewForm.name.trim()) { toast.error('Crew name is required'); return; }
                    createCrew.mutate({ name: crewForm.name.trim(), dailyCapacity: crewForm.dailyCapacity ? Number(crewForm.dailyCapacity) : undefined, notes: crewForm.notes || undefined });
                  }}
                  disabled={createCrew.isPending}
                  className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >Create</button>
                <button onClick={() => setShowCrewForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600">Cancel</button>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-500">
                  <th className="px-4 py-3 font-medium">Crew</th>
                  <th className="px-4 py-3 font-medium">Capacity / day</th>
                  <th className="px-4 py-3 font-medium">Active</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Notes</th>
                  {isManager && <th className="px-4 py-3 font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {crews.length === 0 ? (
                  <tr><td colSpan={isManager ? 5 : 4} className="px-4 py-8 text-center text-gray-500">No crews</td></tr>
                ) : (
                  crews.map((c) =>
                    editingCrewId === c.id ? (
                      <tr key={c.id} className="bg-primary/5">
                        <td colSpan={isManager ? 5 : 4} className="px-4 py-4">
                          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-center">
                            <input value={editCrewForm.name} onChange={(e) => setEditCrewForm({ ...editCrewForm, name: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            <input type="number" min={1} max={20} value={editCrewForm.dailyCapacity} onChange={(e) => setEditCrewForm({ ...editCrewForm, dailyCapacity: e.target.value })} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                            <label className="flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" checked={editCrewForm.active} onChange={(e) => setEditCrewForm({ ...editCrewForm, active: e.target.checked })} /> Active</label>
                            <div className="flex gap-2">
                              <button onClick={() => updateCrew.mutate({ id: c.id, payload: { name: editCrewForm.name, active: editCrewForm.active, dailyCapacity: Number(editCrewForm.dailyCapacity), notes: editCrewForm.notes || undefined } })} disabled={updateCrew.isPending} className="px-3 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50">Save</button>
                              <button onClick={() => setEditingCrewId(null)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-600">Cancel</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={c.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                        <td className="px-4 py-3 text-gray-600">{c.dailyCapacity}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${c.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{c.active ? 'Active' : 'Inactive'}</span>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-gray-500 text-xs">{c.notes || '—'}</td>
                        {isManager && (
                          <td className="px-4 py-3">
                            <button onClick={() => startEditCrew(c)} className="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-50 rounded hover:bg-gray-100">Edit</button>
                          </td>
                        )}
                      </tr>
                    ),
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== Job detail drawer ===== */}
      {selectedJobId && (
        <JobDrawer
          jobId={selectedJobId}
          crews={crews}
          onClose={() => setSelectedJobId(null)}
          onChanged={invalidateAll}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Job detail drawer: schedule, status state-machine, task checklist.
// ---------------------------------------------------------------------------
function JobDrawer({
  jobId,
  crews,
  onClose,
  onChanged,
}: {
  jobId: string;
  crews: InstallationCrew[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();

  const [schedCrew, setSchedCrew] = useState('');
  const [schedDate, setSchedDate] = useState('');
  const [schedWindow, setSchedWindow] = useState('');
  const [newTask, setNewTask] = useState('');

  const { data: job, isLoading } = useQuery<InstallationJob>({
    queryKey: ['marketing', 'installations', 'job', jobId],
    queryFn: () => marketingApi.get(`/installations/jobs/${jobId}`).then((r) => r.data),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'installations', 'job', jobId] });
    onChanged();
  };

  const schedule = useMutation({
    mutationFn: () => marketingApi.post(`/installations/jobs/${jobId}/schedule`, { crewId: schedCrew, scheduledDate: schedDate, scheduledWindow: schedWindow || undefined }),
    onSuccess: () => { toast.success('Job scheduled'); refresh(); },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to schedule')),
  });

  const setStatus = useMutation({
    mutationFn: (s: string) => marketingApi.patch(`/installations/jobs/${jobId}/status`, { status: s }),
    onSuccess: () => { toast.success('Status updated'); refresh(); },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to update status')),
  });

  const addTask = useMutation({
    mutationFn: (title: string) => marketingApi.post(`/installations/jobs/${jobId}/tasks`, { title }),
    onSuccess: () => { setNewTask(''); refresh(); },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to add task')),
  });

  const toggleTask = useMutation({
    mutationFn: (taskId: string) => marketingApi.patch(`/installations/jobs/${jobId}/tasks/${taskId}/toggle`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(errMsg(e, 'Failed')),
  });

  const deleteTask = useMutation({
    mutationFn: (taskId: string) => marketingApi.delete(`/installations/jobs/${jobId}/tasks/${taskId}`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(errMsg(e, 'Failed')),
  });

  const transitions = job ? INSTALLATION_TRANSITIONS[job.status] || [] : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-md bg-white shadow-xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-gray-900">Installation job</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><XMarkIcon className="w-5 h-5" /></button>
        </div>

        {isLoading || !job ? (
          <div className="p-8 text-center text-gray-500">Loading…</div>
        ) : (
          <div className="p-5 space-y-5">
            <div className="space-y-1">
              <StatusBadge status={job.status} />
              <p className="text-sm text-gray-900 font-medium mt-2">{job.contactName || '—'}</p>
              <p className="text-sm text-gray-500">{[job.siteAddress, job.siteCity].filter(Boolean).join(', ') || 'No address'}</p>
              {job.contactPhone && <p className="text-sm text-gray-500">{job.contactPhone}</p>}
              {job.notes && <p className="text-sm text-gray-600 mt-2">{job.notes}</p>}
            </div>

            {/* Schedule */}
            {job.status === InstallationStatus.REQUESTED && (
              <div className="border rounded-lg p-4 space-y-3">
                <p className="text-sm font-semibold text-gray-700">Schedule</p>
                <select value={schedCrew} onChange={(e) => setSchedCrew(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                  <option value="">Select crew…</option>
                  {crews.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name} (cap {c.dailyCapacity}/day)</option>)}
                </select>
                <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <select value={schedWindow} onChange={(e) => setSchedWindow(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                  <option value="">Any window</option>
                  {WINDOWS.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                <button onClick={() => { if (!schedCrew || !schedDate) { toast.error('Crew and date are required'); return; } schedule.mutate(); }} disabled={schedule.isPending} className="w-full px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {schedule.isPending ? 'Scheduling…' : 'Schedule'}
                </button>
              </div>
            )}

            {/* Status state-machine */}
            {transitions.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-gray-700">Move to</p>
                <div className="flex flex-wrap gap-2">
                  {transitions.map((s) => (
                    <button key={s} onClick={() => setStatus.mutate(s)} disabled={setStatus.isPending} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      {INSTALLATION_STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Task checklist */}
            <div className="space-y-2">
              <p className="text-sm font-semibold text-gray-700">Checklist</p>
              <div className="space-y-1">
                {job.tasks.length === 0 && <p className="text-sm text-gray-400">No tasks yet</p>}
                {job.tasks.sort((a, b) => a.position - b.position).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 group">
                    <input type="checkbox" checked={t.done} onChange={() => toggleTask.mutate(t.id)} className="rounded" />
                    <span className={`flex-1 text-sm ${t.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{t.title}</span>
                    <button onClick={() => deleteTask.mutate(t.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500"><TrashIcon className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newTask} onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newTask.trim()) addTask.mutate(newTask.trim()); }} placeholder="Add task…" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                <button onClick={() => newTask.trim() && addTask.mutate(newTask.trim())} disabled={!newTask.trim() || addTask.isPending} className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm disabled:opacity-50">Add</button>
              </div>
            </div>

            {!isManager && <p className="text-xs text-gray-400">Crew and job creation are manager-only.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
