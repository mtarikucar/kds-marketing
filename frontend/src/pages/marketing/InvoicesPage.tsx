import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DocumentTextIcon, TrashIcon, PlusIcon, ClipboardIcon, CheckIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';

interface InvoiceRow { id: string; number: string; total: number; currency: string; status: string; createdAt: string }
interface Item { description: string; qty: number; price: string }

export default function InvoicesPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [currency, setCurrency] = useState('TRY');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<Item[]>([{ description: '', qty: 1, price: '' }]);
  const [psp, setPsp] = useState({ provider: 'MANUAL', secretKey: '', instructions: '' });

  const { data: invoices } = useQuery<InvoiceRow[]>({ queryKey: ['marketing', 'invoices'], queryFn: () => marketingApi.get('/invoices').then((r) => r.data), refetchInterval: 20_000 });
  const { data: pspCfg } = useQuery({ queryKey: ['marketing', 'invoices', 'psp'], queryFn: () => marketingApi.get('/invoices/psp').then((r) => r.data) });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'invoices'] });
  const reset = () => { setItems([{ description: '', qty: 1, price: '' }]); setNotes(''); setShowForm(false); };

  const create = useMutation({
    mutationFn: () => marketingApi.post('/invoices', {
      currency, notes: notes || undefined,
      items: items.filter((i) => i.description).map((i) => ({ description: i.description, qty: Number(i.qty) || 1, unitPrice: Math.round((Number(i.price) || 0) * 100) })),
    }),
    onSuccess: () => { invalidate(); reset(); toast.success(t('invoices.created', 'Invoice created')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('invoices.saveFailed', 'Save failed')),
  });
  const send = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/send`),
    onSuccess: ({ data }) => { invalidate(); navigator.clipboard.writeText(data.payUrl); toast.success(t('invoices.sent', 'Sent — pay link copied')); },
  });
  const markPaid = useMutation({ mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/mark-paid`), onSuccess: invalidate });
  const voidInv = useMutation({ mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/void`), onSuccess: invalidate });
  const savePsp = useMutation({
    mutationFn: () => marketingApi.put('/invoices/psp', {
      provider: psp.provider,
      secrets: psp.provider === 'STRIPE' && psp.secretKey ? { secretKey: psp.secretKey } : undefined,
      configPublic: psp.provider === 'MANUAL' && psp.instructions ? { instructions: psp.instructions } : undefined,
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['marketing', 'invoices', 'psp'] }); setPsp((p) => ({ ...p, secretKey: '' })); toast.success(t('invoices.pspSaved', 'Payment settings saved')); },
  });

  const total = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const inputCls = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('invoices.title', 'Invoices')}</h1>
          <p className="text-sm text-slate-500">{t('invoices.subtitle', 'Bill your customers and collect via your own Stripe or bank transfer.')}</p>
        </div>
        <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90">{t('invoices.new', 'New invoice')}</button>
      </div>

      {/* PSP settings */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-900 mb-3">{t('invoices.payments', 'How you get paid')}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>{t('invoices.provider', 'Provider')}</label>
            <select value={psp.provider} onChange={(e) => setPsp({ ...psp, provider: e.target.value })} className={inputCls}>
              <option value="MANUAL">{t('invoices.manual', 'Bank transfer (manual)')}</option>
              <option value="STRIPE">Stripe</option>
            </select>
          </div>
          {psp.provider === 'STRIPE' ? (
            <div className="flex-1 min-w-48">
              <label className={labelCls}>{t('invoices.stripeKey', 'Your Stripe secret key')} {pspCfg?.configuredSecrets?.includes('secretKey') && <span className="text-emerald-500">✓ set</span>}</label>
              <input type="password" value={psp.secretKey} onChange={(e) => setPsp({ ...psp, secretKey: e.target.value })} className={`${inputCls} w-full`} placeholder="sk_live_…" autoComplete="off" />
            </div>
          ) : (
            <div className="flex-1 min-w-48">
              <label className={labelCls}>{t('invoices.instructions', 'Payment instructions (shown to payer)')}</label>
              <input value={psp.instructions} onChange={(e) => setPsp({ ...psp, instructions: e.target.value })} className={`${inputCls} w-full`} placeholder="IBAN TR.. — Acme Ltd" />
            </div>
          )}
          <button onClick={() => savePsp.mutate()} className="px-3 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800">{t('common.save', 'Save')}</button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <input value={it.description} onChange={(e) => { const a = [...items]; a[i] = { ...it, description: e.target.value }; setItems(a); }} className={`${inputCls} w-full sm:w-auto sm:flex-1`} placeholder={t('invoices.itemDesc', 'Description')} />
                <input type="number" value={it.qty} onChange={(e) => { const a = [...items]; a[i] = { ...it, qty: Number(e.target.value) }; setItems(a); }} className={`${inputCls} w-20`} placeholder="Qty" />
                <input type="number" value={it.price} onChange={(e) => { const a = [...items]; a[i] = { ...it, price: e.target.value }; setItems(a); }} className={`${inputCls} w-28`} placeholder={t('invoices.unitPrice', 'Unit price')} />
                <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="p-2 text-red-400 hover:bg-red-50 rounded-lg shrink-0"><TrashIcon className="w-4 h-4" /></button>
              </div>
            ))}
            <button onClick={() => setItems([...items, { description: '', qty: 1, price: '' }])} className="text-xs text-primary hover:underline flex items-center gap-1"><PlusIcon className="w-3 h-3" />{t('invoices.addItem', 'Add line')}</button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div><label className={labelCls}>{t('invoices.currency', 'Currency')}</label><select value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls}><option>TRY</option><option>USD</option><option>EUR</option></select></div>
            <div className="flex-1"><label className={labelCls}>{t('invoices.notes', 'Notes')}</label><input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${inputCls} w-full`} /></div>
            <div className="text-lg font-bold text-slate-900">{total.toLocaleString()} {currency}</div>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={reset} className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">{t('common.cancel', 'Cancel')}</button>
            <button onClick={() => create.mutate()} disabled={create.isPending || !items.some((i) => i.description)} className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50">{t('invoices.createBtn', 'Create')}</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {(invoices ?? []).map((inv) => (
          <div key={inv.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <DocumentTextIcon className="w-5 h-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="font-medium text-slate-900">{inv.number}
                  <span className={`ml-2 text-xs px-2 py-0.5 rounded-full border ${inv.status === 'PAID' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : inv.status === 'SENT' ? 'bg-blue-50 text-blue-700 border-blue-200' : inv.status === 'VOID' ? 'bg-slate-100 text-slate-400 border-slate-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{inv.status}</span>
                </div>
                <div className="text-xs text-slate-400">{(inv.total / 100).toLocaleString()} {inv.currency} · {new Date(inv.createdAt).toLocaleDateString()}</div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {inv.status !== 'PAID' && inv.status !== 'VOID' && (
                <>
                  <button onClick={() => send.mutate(inv.id)} title={t('invoices.send', 'Send / copy pay link')} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"><ClipboardIcon className="w-4 h-4" /></button>
                  <button onClick={() => markPaid.mutate(inv.id)} title={t('invoices.markPaid', 'Mark paid')} className="p-2 rounded-lg text-emerald-500 hover:bg-emerald-50"><CheckIcon className="w-4 h-4" /></button>
                  <button onClick={() => voidInv.mutate(inv.id)} className="p-2 rounded-lg text-red-400 hover:bg-red-50"><TrashIcon className="w-4 h-4" /></button>
                </>
              )}
            </div>
          </div>
        ))}
        {(invoices ?? []).length === 0 && !showForm && <div className="bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 text-sm">{t('invoices.empty', 'No invoices yet.')}</div>}
      </div>
    </div>
  );
}
