import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  PhoneIcon,
  EnvelopeIcon,
  MapPinIcon,
  PencilSquareIcon,
  ArrowLeftIcon,
  TrashIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { LeadStatusBadge, ActivityTimeline, AssignCell } from '../../features/marketing/components';
import {
  LeadStatus,
  LEAD_STATUS_LABELS,
  BUSINESS_TYPE_LABELS,
  LEAD_SOURCE_LABELS,
  ActivityType,
  TaskType,
} from '../../features/marketing/types';
import type { Lead, LeadActivity, LeadOffer, MarketingTask } from '../../features/marketing/types';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';

const offerStatusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  ACCEPTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-orange-100 text-orange-800',
};

const taskPriorityColors: Record<string, string> = {
  LOW: 'text-gray-500',
  MEDIUM: 'text-blue-600',
  HIGH: 'text-orange-600',
  URGENT: 'text-red-600',
};

type DetailLead = Lead & {
  activities: LeadActivity[];
  offers: LeadOffer[];
  tasks: MarketingTask[];
};

// RFC 5321 / 5322 lite: enough to catch typos (missing @, leading dot,
// trailing whitespace) without falsely rejecting real addresses. Full
// validation happens on the server when /convert is called.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors the backend admin-password rule for the /convert endpoint.
// Anything shorter would be rejected with a 400 anyway — catching it
// in the form means the user doesn't have to wait for a round-trip.
const MIN_PASSWORD_LENGTH = 6;

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { i18n, t } = useTranslation('marketing');
  // Locale-aware date formatting: `toLocaleDateString()` with no arg
  // uses the runtime locale, which on a Turkish admin's browser is
  // usually `en-US` from the OS-level default. Threading i18n.language
  // through keeps every date in the same locale the rest of the UI
  // uses, no matter what the browser thinks.
  const locale = i18n.language || 'tr';
  const fmtDate = (d: string | Date | null | undefined) =>
    d ? new Date(d).toLocaleDateString(locale) : '';
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // UI state
  const [activeTab, setActiveTab] = useState<'activities' | 'offers' | 'tasks'>('activities');
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);

  // Activity form
  const [activityType, setActivityType] = useState<string>('NOTE');
  const [activityTitle, setActivityTitle] = useState('');
  const [activityDesc, setActivityDesc] = useState('');

  // Offer form
  const [offerPrice, setOfferPrice] = useState('');
  const [offerDiscount, setOfferDiscount] = useState('');
  const [offerTrial, setOfferTrial] = useState('');
  const [offerNotes, setOfferNotes] = useState('');
  const [offerValidUntil, setOfferValidUntil] = useState('');

  // Task form
  const [taskTitle, setTaskTitle] = useState('');
  const [taskType, setTaskType] = useState<string>('FOLLOW_UP');
  const [taskPriority, setTaskPriority] = useState('MEDIUM');
  const [taskDueDate, setTaskDueDate] = useState('');
  const [taskDesc, setTaskDesc] = useState('');

  // Convert form
  const [convertTenant, setConvertTenant] = useState('');
  const [convertEmail, setConvertEmail] = useState('');
  const [convertFirstName, setConvertFirstName] = useState('');
  const [convertLastName, setConvertLastName] = useState('');
  const [convertPassword, setConvertPassword] = useState('');
  const [convertOfferId, setConvertOfferId] = useState('');
  const [convertCommission, setConvertCommission] = useState('');

  // Close the convert modal on Escape. The modal otherwise traps the
  // user with no keyboard-only exit, which is a WCAG 2.1 fail and
  // surprising for power users who reflexively hit Esc on dialogs.
  useEffect(() => {
    if (!showConvertModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowConvertModal(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showConvertModal]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', id] });

  const { data: lead, isLoading } = useQuery({
    queryKey: ['marketing', 'lead', id],
    queryFn: () => marketingApi.get<DetailLead>(`/leads/${id}`).then((r) => r.data),
  });

  // Mutations
  const statusMutation = useMutation({
    mutationFn: (status: string) => marketingApi.patch(`/leads/${id}/status`, { status }),
    onSuccess: () => { invalidate(); toast.success('Status updated'); },
    onError: () => toast.error('Failed to update status'),
  });

  const activityMutation = useMutation({
    mutationFn: (data: { type: string; title: string; description?: string }) =>
      marketingApi.post(`/leads/${id}/activities`, data),
    onSuccess: () => {
      invalidate();
      setShowActivityForm(false);
      setActivityTitle('');
      setActivityDesc('');
      toast.success('Activity added');
    },
    onError: () => toast.error('Failed to add activity'),
  });

  const createOfferMutation = useMutation({
    mutationFn: (data: any) => marketingApi.post('/offers', data),
    onSuccess: () => {
      invalidate();
      setShowOfferForm(false);
      setOfferPrice(''); setOfferDiscount(''); setOfferTrial(''); setOfferNotes(''); setOfferValidUntil('');
      toast.success('Offer created');
    },
    onError: () => toast.error('Failed to create offer'),
  });

  const sendOfferMutation = useMutation({
    mutationFn: (offerId: string) => marketingApi.post(`/offers/${offerId}/send`),
    onSuccess: () => { invalidate(); toast.success('Offer sent'); },
    onError: () => toast.error('Failed to send offer'),
  });

  const deleteOfferMutation = useMutation({
    mutationFn: (offerId: string) => marketingApi.delete(`/offers/${offerId}`),
    onSuccess: () => { invalidate(); toast.success('Offer deleted'); },
    onError: () => toast.error('Failed to delete offer'),
  });

  const createTaskMutation = useMutation({
    mutationFn: (data: any) => marketingApi.post('/tasks', data),
    onSuccess: () => {
      invalidate();
      setShowTaskForm(false);
      setTaskTitle(''); setTaskDesc(''); setTaskDueDate('');
      toast.success('Task created');
    },
    onError: () => toast.error('Failed to create task'),
  });

  const completeTaskMutation = useMutation({
    mutationFn: (taskId: string) => marketingApi.patch(`/tasks/${taskId}/complete`),
    onSuccess: () => { invalidate(); toast.success('Task completed'); },
    onError: () => toast.error('Failed to complete task'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => marketingApi.delete(`/tasks/${taskId}`),
    onSuccess: () => { invalidate(); toast.success('Task deleted'); },
    onError: () => toast.error('Failed to delete task'),
  });

  const convertMutation = useMutation({
    mutationFn: (data: any) => marketingApi.post(`/leads/${id}/convert`, data),
    onSuccess: () => {
      invalidate();
      setShowConvertModal(false);
      toast.success('Lead converted successfully!');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Failed to convert lead'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => marketingApi.delete(`/leads/${id}`),
    onSuccess: () => { toast.success('Lead deleted'); navigate('/leads'); },
    onError: () => toast.error('Failed to delete lead'),
  });

  if (isLoading) return <div className="text-center py-12 text-gray-500">Loading...</div>;
  if (!lead) return <div className="text-center py-12 text-gray-500">Lead not found</div>;

  const canConvert = ['OFFER_SENT', 'WAITING'].includes(lead.status) && !lead.convertedTenantId;
  const sentOffers = (lead.offers || []).filter((o) => o.status === 'SENT');

  const initConvertForm = () => {
    setConvertTenant(lead.businessName);
    setConvertEmail(lead.email || '');
    const parts = (lead.contactPerson || '').split(' ');
    setConvertFirstName(parts[0] || '');
    setConvertLastName(parts.slice(1).join(' ') || '');
    setConvertPassword('');
    setConvertOfferId(sentOffers[0]?.id || '');
    setConvertCommission('');
    setShowConvertModal(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link to="/leads" className="p-2 hover:bg-gray-100 rounded-lg">
            <ArrowLeftIcon className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{lead.businessName}</h1>
            <p className="text-sm text-gray-500">{lead.contactPerson}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <LeadStatusBadge status={lead.status} />
          {canConvert && (
            <button onClick={initConvertForm} className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
              Convert to Customer
            </button>
          )}
          {/* Header-level assignment — primary discoverability point.
              Sol panel'deki "Assign Lead" kartı semantik bütünlük için
              duruyor; iki AssignCell instance aynı queryKey'leri paylaşır,
              biri mutate ettiğinde diğeri invalidate olur (no manual sync). */}
          {isManager && (
            <div className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
              <AssignCell
                leadId={lead.id}
                currentAssignee={lead.assignedTo ?? null}
                onAssigned={invalidate}
              />
            </div>
          )}
          <Link to={`/leads/${id}/edit`} className="flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
            <PencilSquareIcon className="w-4 h-4" /> Edit
          </Link>
          {isManager && (
            <button
              onClick={() => { if (window.confirm('Delete this lead?')) deleteMutation.mutate(); }}
              className="flex items-center gap-1 px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-sm hover:bg-red-50"
            >
              <TrashIcon className="w-4 h-4" /> Delete
            </button>
          )}
        </div>
      </div>

      {lead.convertedTenantId && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
          This lead has been converted to a customer on {lead.convertedAt ? fmtDate(lead.convertedAt) : 'N/A'}.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Info */}
        <div className="lg:col-span-1 space-y-4">
          {/* Contact Info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Contact Info</h3>
            <div className="space-y-2 text-sm">
              {lead.phone && (
                <div className="flex items-center gap-2">
                  <PhoneIcon className="w-4 h-4 text-gray-400" />
                  <a href={`tel:${lead.phone}`} className="text-primary hover:underline">{lead.phone}</a>
                </div>
              )}
              {lead.whatsapp && (
                <div className="flex items-center gap-2">
                  <PhoneIcon className="w-4 h-4 text-green-500" />
                  <a href={`https://wa.me/${lead.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:underline">WhatsApp</a>
                </div>
              )}
              {lead.email && (
                <div className="flex items-center gap-2">
                  <EnvelopeIcon className="w-4 h-4 text-gray-400" />
                  <a href={`mailto:${lead.email}`} className="text-primary hover:underline">{lead.email}</a>
                </div>
              )}
              {(lead.city || lead.address) && (
                <div className="flex items-center gap-2">
                  <MapPinIcon className="w-4 h-4 text-gray-400" />
                  <span className="text-gray-600">{lead.city}{lead.address ? `, ${lead.address}` : ''}</span>
                </div>
              )}
            </div>
          </div>

          {/* Business Info */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Business Details</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Type</dt><dd className="text-gray-900">{BUSINESS_TYPE_LABELS[lead.businessType as keyof typeof BUSINESS_TYPE_LABELS] || lead.businessType}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Source</dt><dd className="text-gray-900">{LEAD_SOURCE_LABELS[lead.source as keyof typeof LEAD_SOURCE_LABELS] || lead.source}</dd></div>
              {lead.tableCount != null && <div className="flex justify-between"><dt className="text-gray-500">Tables</dt><dd className="text-gray-900">{lead.tableCount}</dd></div>}
              {lead.branchCount != null && <div className="flex justify-between"><dt className="text-gray-500">Branches</dt><dd className="text-gray-900">{lead.branchCount}</dd></div>}
              {lead.currentSystem && <div className="flex justify-between"><dt className="text-gray-500">Current System</dt><dd className="text-gray-900">{lead.currentSystem}</dd></div>}
              {lead.assignedTo && <div className="flex justify-between"><dt className="text-gray-500">Assigned To</dt><dd className="text-gray-900">{lead.assignedTo.firstName} {lead.assignedTo.lastName}</dd></div>}
              {lead.nextFollowUp && <div className="flex justify-between"><dt className="text-gray-500">Next Follow-up</dt><dd className="text-gray-900">{fmtDate(lead.nextFollowUp)}</dd></div>}
            </dl>
          </div>

          {/* Assign (Manager only) — compact inline popover so the rest
              of the panel still serves as the lead's info hub. */}
          {isManager && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">
                {t('leads.assignment.title')}
              </h3>
              <AssignCell
                leadId={lead.id}
                currentAssignee={lead.assignedTo ?? null}
                onAssigned={invalidate}
              />
            </div>
          )}

          {/* Status Change */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Change Status</h3>
            <div className="flex flex-wrap gap-2">
              {/* WON is owned by the /convert flow on the backend
                  (marketing-leads.service.ts:295-299) — exposing a WON
                  button here just produced a 400 every time. */}
              {Object.values(LeadStatus)
                .filter((s) => s !== LeadStatus.WON)
                .map((s) => (
                  <button
                    key={s}
                    onClick={() => statusMutation.mutate(s)}
                    disabled={lead.status === s || statusMutation.isPending}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      lead.status === s ? 'bg-primary/15 border-primary/40 text-primary' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    } disabled:opacity-50`}
                  >
                    {LEAD_STATUS_LABELS[s]}
                  </button>
                ))}
            </div>
          </div>

          {lead.notes && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Notes</h3>
              <p className="text-sm text-gray-600 whitespace-pre-wrap">{lead.notes}</p>
            </div>
          )}
        </div>

        {/* Right: Tabs */}
        <div className="lg:col-span-2 space-y-4">
          {/* Tab buttons */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(['activities', 'offers', 'tasks'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab === 'activities' ? 'Activities' : tab === 'offers' ? `Offers (${lead.offers?.length || 0})` : `Tasks (${lead.tasks?.length || 0})`}
              </button>
            ))}
          </div>

          {/* Activities Tab */}
          {activeTab === 'activities' && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Activity Timeline</h3>
                <button onClick={() => setShowActivityForm(!showActivityForm)} className="text-sm text-primary hover:text-primary/80 font-medium">+ Add Activity</button>
              </div>
              {showActivityForm && (
                <div className="mb-6 p-4 bg-gray-50 rounded-lg space-y-3">
                  <div className="flex gap-3">
                    <select value={activityType} onChange={(e) => setActivityType(e.target.value)} className="px-3 py-2 border rounded-lg text-sm">
                      {Object.values(ActivityType).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input type="text" placeholder="Activity title" value={activityTitle} onChange={(e) => setActivityTitle(e.target.value)} className="flex-1 px-3 py-2 border rounded-lg text-sm" />
                  </div>
                  <textarea placeholder="Description (optional)" value={activityDesc} onChange={(e) => setActivityDesc(e.target.value)} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => activityMutation.mutate({ type: activityType, title: activityTitle, description: activityDesc || undefined })} disabled={!activityTitle || activityMutation.isPending} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                      {activityMutation.isPending ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={() => setShowActivityForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">Cancel</button>
                  </div>
                </div>
              )}
              <ActivityTimeline activities={lead.activities || []} />
            </div>
          )}

          {/* Offers Tab */}
          {activeTab === 'offers' && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Offers</h3>
                {!lead.convertedTenantId && (
                  <button onClick={() => setShowOfferForm(!showOfferForm)} className="text-sm text-primary hover:text-primary/80 font-medium">+ New Offer</button>
                )}
              </div>

              {showOfferForm && (
                <div className="mb-6 p-4 bg-gray-50 rounded-lg space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Custom Price</label>
                      <input type="number" value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="0.00" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Discount (%)</label>
                      <input type="number" value={offerDiscount} onChange={(e) => setOfferDiscount(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="0" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Trial Days</label>
                      <input type="number" value={offerTrial} onChange={(e) => setOfferTrial(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="14" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Valid Until</label>
                      <input type="date" value={offerValidUntil} onChange={(e) => setOfferValidUntil(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
                    </div>
                  </div>
                  <textarea placeholder="Notes" value={offerNotes} onChange={(e) => setOfferNotes(e.target.value)} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm" />
                  <div className="flex gap-2">
                    <button
                      onClick={() => createOfferMutation.mutate({
                        leadId: id,
                        ...(offerPrice ? { customPrice: Number(offerPrice) } : {}),
                        ...(offerDiscount ? { discount: Number(offerDiscount) } : {}),
                        ...(offerTrial ? { trialDays: Number(offerTrial) } : {}),
                        ...(offerValidUntil ? { validUntil: offerValidUntil } : {}),
                        ...(offerNotes ? { notes: offerNotes } : {}),
                      })}
                      disabled={createOfferMutation.isPending}
                      className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      {createOfferMutation.isPending ? 'Creating...' : 'Create Offer'}
                    </button>
                    <button onClick={() => setShowOfferForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">Cancel</button>
                  </div>
                </div>
              )}

              {(lead.offers || []).length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-6">No offers yet</p>
              ) : (
                <div className="space-y-3">
                  {(lead.offers || []).map((offer) => (
                    <div key={offer.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${offerStatusColors[offer.status] || 'bg-gray-100'}`}>
                          {offer.status}
                        </span>
                        <span className="text-xs text-gray-400">{fmtDate(offer.createdAt)}</span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm mb-3">
                        {offer.customPrice && <div><span className="text-gray-500">Price:</span> <span className="font-medium">{offer.customPrice}</span></div>}
                        {offer.discount && <div><span className="text-gray-500">Discount:</span> <span className="font-medium">{offer.discount}%</span></div>}
                        {offer.trialDays && <div><span className="text-gray-500">Trial:</span> <span className="font-medium">{offer.trialDays} days</span></div>}
                      </div>
                      {offer.validUntil && <p className="text-xs text-gray-400 mb-2">Valid until: {fmtDate(offer.validUntil)}</p>}
                      {offer.notes && <p className="text-sm text-gray-600 mb-3">{offer.notes}</p>}
                      <div className="flex gap-2">
                        {offer.status === 'DRAFT' && (
                          <>
                            <button onClick={() => sendOfferMutation.mutate(offer.id)} className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700">Send</button>
                            <button onClick={() => { if (window.confirm('Delete this offer?')) deleteOfferMutation.mutate(offer.id); }} className="px-3 py-1 border border-red-300 text-red-600 rounded text-xs hover:bg-red-50">Delete</button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tasks Tab */}
          {activeTab === 'tasks' && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Tasks</h3>
                <button onClick={() => setShowTaskForm(!showTaskForm)} className="text-sm text-primary hover:text-primary/80 font-medium">+ New Task</button>
              </div>

              {showTaskForm && (
                <div className="mb-6 p-4 bg-gray-50 rounded-lg space-y-3">
                  <div className="flex gap-3">
                    <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className="px-3 py-2 border rounded-lg text-sm">
                      {Object.values(TaskType).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input type="text" placeholder="Task title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} className="flex-1 px-3 py-2 border rounded-lg text-sm" />
                  </div>
                  <div className="flex gap-3">
                    <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value)} className="px-3 py-2 border rounded-lg text-sm">
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                      <option value="URGENT">Urgent</option>
                    </select>
                    <input type="date" value={taskDueDate} onChange={(e) => setTaskDueDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
                  </div>
                  <textarea placeholder="Description (optional)" value={taskDesc} onChange={(e) => setTaskDesc(e.target.value)} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm" />
                  <div className="flex gap-2">
                    <button
                      onClick={() => createTaskMutation.mutate({
                        title: taskTitle,
                        type: taskType,
                        priority: taskPriority,
                        dueDate: taskDueDate,
                        leadId: id,
                        ...(taskDesc ? { description: taskDesc } : {}),
                      })}
                      disabled={!taskTitle || !taskDueDate || createTaskMutation.isPending}
                      className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      {createTaskMutation.isPending ? 'Creating...' : 'Create Task'}
                    </button>
                    <button onClick={() => setShowTaskForm(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">Cancel</button>
                  </div>
                </div>
              )}

              {(lead.tasks || []).length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-6">No tasks yet</p>
              ) : (
                <div className="space-y-2">
                  {(lead.tasks || []).map((task) => (
                    <div key={task.id} className="flex items-center gap-3 border border-gray-200 rounded-lg p-3">
                      <button
                        onClick={() => task.status !== 'COMPLETED' && completeTaskMutation.mutate(task.id)}
                        disabled={task.status === 'COMPLETED'}
                        className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                          task.status === 'COMPLETED' ? 'bg-green-500 border-green-500' : 'border-gray-300 hover:border-green-400'
                        }`}
                      >
                        {task.status === 'COMPLETED' && <CheckCircleIcon className="w-4 h-4 text-white" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${task.status === 'COMPLETED' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                          {task.title}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                          <span className="bg-gray-100 px-1.5 py-0.5 rounded">{task.type}</span>
                          <span className={taskPriorityColors[task.priority] || ''}>{task.priority}</span>
                          <span>Due: {fmtDate(task.dueDate)}</span>
                        </div>
                      </div>
                      {task.status !== 'COMPLETED' && (
                        <button
                          onClick={() => { if (window.confirm('Delete this task?')) deleteTaskMutation.mutate(task.id); }}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Convert Modal */}
      {showConvertModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Convert Lead to Customer</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Tenant Name *</label>
                <input type="text" value={convertTenant} onChange={(e) => setConvertTenant(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Admin Email *</label>
                <input
                  type="email"
                  required
                  value={convertEmail}
                  onChange={(e) => setConvertEmail(e.target.value)}
                  className={`w-full px-3 py-2 border rounded-lg text-sm ${
                    convertEmail && !EMAIL_RE.test(convertEmail)
                      ? 'border-red-400 focus:ring-red-300'
                      : ''
                  }`}
                />
                {convertEmail && !EMAIL_RE.test(convertEmail) && (
                  <p className="text-xs text-red-600 mt-1">Invalid email format.</p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">First Name *</label>
                  <input type="text" value={convertFirstName} onChange={(e) => setConvertFirstName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Last Name *</label>
                  <input type="text" value={convertLastName} onChange={(e) => setConvertLastName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Admin Password *</label>
                <input
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  value={convertPassword}
                  onChange={(e) => setConvertPassword(e.target.value)}
                  className={`w-full px-3 py-2 border rounded-lg text-sm ${
                    convertPassword && convertPassword.length < MIN_PASSWORD_LENGTH
                      ? 'border-red-400 focus:ring-red-300'
                      : ''
                  }`}
                  placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}
                />
                {convertPassword && convertPassword.length < MIN_PASSWORD_LENGTH && (
                  <p className="text-xs text-red-600 mt-1">
                    Password must be at least {MIN_PASSWORD_LENGTH} characters.
                  </p>
                )}
              </div>
              {sentOffers.length > 0 && (
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Link Offer (optional)</label>
                  <select value={convertOfferId} onChange={(e) => setConvertOfferId(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm">
                    <option value="">No offer</option>
                    {sentOffers.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.customPrice ? `${o.customPrice} TL` : 'Standard'} {o.discount ? `(${o.discount}% off)` : ''} — {fmtDate(o.createdAt)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-600 mb-1">Commission Amount</label>
                <input type="number" value={convertCommission} onChange={(e) => setConvertCommission(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="0" />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => convertMutation.mutate({
                  tenantName: convertTenant,
                  adminEmail: convertEmail,
                  adminFirstName: convertFirstName,
                  adminLastName: convertLastName,
                  adminPassword: convertPassword,
                  ...(convertOfferId ? { offerId: convertOfferId } : {}),
                  ...(convertCommission ? { commissionAmount: Number(convertCommission) } : {}),
                })}
                disabled={
                  !convertTenant ||
                  !convertEmail ||
                  !EMAIL_RE.test(convertEmail) ||
                  !convertFirstName ||
                  !convertLastName ||
                  !convertPassword ||
                  convertPassword.length < MIN_PASSWORD_LENGTH ||
                  convertMutation.isPending
                }
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {convertMutation.isPending ? 'Converting...' : 'Convert'}
              </button>
              <button onClick={() => setShowConvertModal(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
