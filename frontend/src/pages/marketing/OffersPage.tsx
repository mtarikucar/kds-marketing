import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { PlusIcon, FunnelIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import type { LeadOffer, Lead, PaginatedResponse } from '../../features/marketing/types';
import { fmtDate } from '../../features/marketing/utils/format';

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-800',
  SENT: 'bg-blue-100 text-blue-800',
  ACCEPTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-orange-100 text-orange-800',
};

const OFFER_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;

const emptyForm = {
  leadId: '',
  customPrice: '',
  discount: '',
  trialDays: '',
  notes: '',
  validUntil: '',
};

type OfferForm = typeof emptyForm;

export default function OffersPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  // Filter state — seed status from the URL (?status=SENT) so the dashboard
  // "Offers awaiting reply" deep-link lands pre-filtered.
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<OfferForm>({ ...emptyForm });

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<OfferForm>({ ...emptyForm });

  // Fetch offers
  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'offers', { status, dateFrom, dateTo, page }],
    queryFn: () =>
      marketingApi
        .get<PaginatedResponse<LeadOffer>>('/offers', {
          params: {
            status: status || undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            page,
            limit: 20,
          },
        })
        .then((r) => r.data),
  });

  const offers: LeadOffer[] = data?.data || [];
  const meta = data?.meta;

  // Fetch leads for the dropdown
  const { data: leadsData } = useQuery({
    queryKey: ['marketing', 'leads', 'dropdown'],
    queryFn: () =>
      marketingApi
        .get<PaginatedResponse<Lead>>('/leads', { params: { limit: 100 } })
        .then((r) => r.data),
  });

  const leads: Lead[] = leadsData?.data || [];

  // --- Mutations ---
  const invalidateOffers = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'offers'] });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/offers', payload),
    onSuccess: () => {
      toast.success('Offer created successfully');
      invalidateOffers();
      setShowForm(false);
      setForm({ ...emptyForm });
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to create offer');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      marketingApi.patch(`/offers/${id}`, payload),
    onSuccess: () => {
      toast.success('Offer updated successfully');
      invalidateOffers();
      setEditingId(null);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to update offer');
    },
  });

  const sendMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/offers/${id}/send`),
    onSuccess: () => {
      toast.success('Offer sent');
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to send offer');
    },
  });

  const acceptMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/offers/${id}/accept`),
    onSuccess: () => {
      toast.success('Offer accepted');
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to accept offer');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/offers/${id}/reject`),
    onSuccess: () => {
      toast.success('Offer rejected');
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to reject offer');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/offers/${id}`),
    onSuccess: () => {
      toast.success('Offer deleted');
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to delete offer');
    },
  });

  // --- Helpers ---
  function buildPayload(f: OfferForm): Record<string, unknown> {
    return {
      leadId: f.leadId || undefined,
      customPrice: f.customPrice ? Number(f.customPrice) : undefined,
      discount: f.discount ? Number(f.discount) : undefined,
      trialDays: f.trialDays ? Number(f.trialDays) : undefined,
      notes: f.notes || undefined,
      validUntil: f.validUntil || undefined,
    };
  }

  function handleCreate() {
    if (!form.leadId) {
      toast.error('Please select a lead');
      return;
    }
    createMutation.mutate(buildPayload(form));
  }

  function handleUpdate() {
    if (!editingId) return;
    updateMutation.mutate({ id: editingId, payload: buildPayload(editForm) });
  }

  function startEdit(offer: LeadOffer) {
    setEditingId(offer.id);
    setEditForm({
      leadId: offer.leadId,
      customPrice: offer.customPrice != null ? String(offer.customPrice) : '',
      discount: offer.discount != null ? String(offer.discount) : '',
      trialDays: offer.trialDays != null ? String(offer.trialDays) : '',
      notes: offer.notes || '',
      validUntil: offer.validUntil ? offer.validUntil.split('T')[0] : '',
    });
  }

  // Shared form fields renderer
  function renderFormFields(
    f: OfferForm,
    setF: (v: OfferForm) => void,
    showLeadSelect: boolean,
  ) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {showLeadSelect && (
          <select
            value={f.leadId}
            onChange={(e) => setF({ ...f, leadId: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="">Select Lead...</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.businessName}
              </option>
            ))}
          </select>
        )}
        <input
          type="number"
          placeholder="Custom Price"
          value={f.customPrice}
          onChange={(e) => setF({ ...f, customPrice: e.target.value })}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          min={0}
        />
        <input
          type="number"
          placeholder="Discount (%)"
          value={f.discount}
          onChange={(e) => setF({ ...f, discount: e.target.value })}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          min={0}
          max={100}
        />
        <input
          type="number"
          placeholder="Trial Days"
          value={f.trialDays}
          onChange={(e) => setF({ ...f, trialDays: e.target.value })}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          min={0}
        />
        <input
          type="date"
          placeholder="Valid Until"
          value={f.validUntil}
          onChange={(e) => setF({ ...f, validUntil: e.target.value })}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <textarea
          placeholder="Notes"
          value={f.notes}
          onChange={(e) => setF({ ...f, notes: e.target.value })}
          className="sm:col-span-2 lg:col-span-3 px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none"
          rows={2}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Offers</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          New Offer
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Create New Offer</h2>
          {renderFormFields(form, setForm, true)}
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!form.leadId || createMutation.isPending}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setForm({ ...emptyForm });
              }}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-3">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="">All Statuses</option>
            {OFFER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm ${
              showFilters
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-gray-300 text-gray-600'
            }`}
          >
            <FunnelIcon className="w-4 h-4" />
            Date Range
          </button>
          {(status || dateFrom || dateTo) && (
            <button
              onClick={() => {
                setStatus('');
                setDateFrom('');
                setDateTo('');
                setPage(1);
              }}
              className="text-xs text-primary hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 pt-3 border-t">
            <div>
              <label className="block text-xs text-gray-500 mb-1">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">Lead</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Price</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Discount</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Trial</th>
                <th className="px-4 py-3 font-medium hidden lg:table-cell">Valid Until</th>
                <th className="px-4 py-3 font-medium hidden md:table-cell">Created By</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    Loading...
                  </td>
                </tr>
              ) : offers.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No offers found
                  </td>
                </tr>
              ) : (
                offers.map((offer) =>
                  editingId === offer.id ? (
                    // Inline edit row
                    <tr key={offer.id} className="bg-primary/10/40">
                      <td colSpan={9} className="px-4 py-4">
                        <div className="space-y-3">
                          <p className="text-xs font-medium text-gray-500">
                            Editing offer for{' '}
                            <span className="text-primary">
                              {offer.lead?.businessName || 'Unknown'}
                            </span>
                          </p>
                          {renderFormFields(editForm, setEditForm, false)}
                          <div className="flex gap-2">
                            <button
                              onClick={handleUpdate}
                              disabled={updateMutation.isPending}
                              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                            >
                              {updateMutation.isPending ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    // Normal row
                    <tr key={offer.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        {offer.lead ? (
                          <Link
                            to={`/leads/${offer.lead.id}`}
                            className="font-medium text-primary hover:text-primary/80"
                          >
                            {offer.lead.businessName}
                          </Link>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            statusColors[offer.status] || 'bg-gray-100'
                          }`}
                        >
                          {offer.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {offer.customPrice != null ? `$${offer.customPrice}` : '-'}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {offer.discount != null ? `${offer.discount}%` : '-'}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {offer.trialDays ?? '-'}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-gray-400 text-xs">
                        {offer.validUntil
                          ? fmtDate(offer.validUntil)
                          : '-'}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-gray-600">
                        {offer.createdBy
                          ? `${offer.createdBy.firstName} ${offer.createdBy.lastName}`
                          : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {fmtDate(offer.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          {offer.status === 'DRAFT' && (
                            <>
                              <button
                                onClick={() => sendMutation.mutate(offer.id)}
                                disabled={sendMutation.isPending}
                                className="px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100 disabled:opacity-50"
                              >
                                Send
                              </button>
                              <button
                                onClick={() => startEdit(offer)}
                                className="px-2 py-1 text-xs font-medium text-gray-700 bg-gray-50 rounded hover:bg-gray-100"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => {
                                  if (window.confirm('Delete this offer?')) {
                                    deleteMutation.mutate(offer.id);
                                  }
                                }}
                                disabled={deleteMutation.isPending}
                                className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </>
                          )}
                          {offer.status === 'SENT' && (
                            <>
                              <button
                                onClick={() => acceptMutation.mutate(offer.id)}
                                disabled={acceptMutation.isPending}
                                className="px-2 py-1 text-xs font-medium text-green-700 bg-green-50 rounded hover:bg-green-100 disabled:opacity-50"
                              >
                                Accept
                              </button>
                              <button
                                onClick={() => rejectMutation.mutate(offer.id)}
                                disabled={rejectMutation.isPending}
                                className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 disabled:opacity-50"
                              >
                                Reject
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">
              Showing {(meta.page - 1) * meta.limit + 1} to{' '}
              {Math.min(meta.page * meta.limit, meta.total)} of {meta.total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= meta.totalPages}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
