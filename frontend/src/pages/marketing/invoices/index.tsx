/**
 * InvoicesPage — Console migration (Phase 4, Task 4).
 * Requires `invoicing` entitlement (gating enforced by the route layer).
 *
 * Preserved verbatim:
 *   - useQuery(['marketing','invoices'], { refetchInterval: 20_000 })
 *   - useQuery(['marketing','invoices','psp'])
 *   - create mutation  → POST /invoices  { currency, notes?, items[{description,qty,unitPrice}] }
 *   - send mutation    → POST /invoices/:id/send  (copies payUrl to clipboard)
 *   - markPaid mut.    → POST /invoices/:id/mark-paid
 *   - voidInv mut.     → POST /invoices/:id/void
 *   - savePsp mut.     → PUT  /invoices/psp  { provider, secrets?, configPublic? }
 *   - invalidate pattern: ['marketing','invoices']
 *   - financial item total display: inv.total / 100  (stored in cents, display in major unit)
 *   - unitPrice conversion: Math.round((Number(price) || 0) * 100) — in InvoiceForm
 *
 * Presentation upgrade:
 *   - PageHeader + "New invoice" action button
 *   - Card for PSP settings (provider Select + key/instructions Input)
 *   - InvoiceForm (extracted sub-component) for create flow
 *   - Table + status Badge for invoice list
 *   - ConfirmDialog for void (destructive)
 *   - EmptyState when no invoices
 *   - Tokens everywhere; dark-mode-safe; lucide icons
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FileText, Clipboard, CheckCircle, Trash2, Plus, MessageSquare, Wallet } from 'lucide-react';
import marketingApi from '@/features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { InvoiceForm } from './InvoiceForm';

interface InvoiceRow {
  id: string;
  number: string;
  total: number;
  currency: string;
  status: string;
  createdAt: string;
}

function invoiceStatusTone(
  status: string,
): 'success' | 'info' | 'neutral' | 'warning' {
  if (status === 'PAID') return 'success';
  if (status === 'SENT') return 'info';
  if (status === 'VOID') return 'neutral';
  return 'warning';
}

export default function InvoicesPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [psp, setPsp] = useState({ provider: 'MANUAL', secretKey: '', instructions: '', merchantId: '', merchantKey: '', merchantSalt: '', apiKey: '' });
  const [voidTarget, setVoidTarget] = useState<InvoiceRow | null>(null);
  // Confirm gate for the two CONSEQUENTIAL, hard-to-undo actions: paying an
  // invoice from the contact's store-credit wallet (an irreversible money
  // movement) and texting the pay link (a billable outbound SMS to a real
  // customer). A single stray click on an icon button must not do either —
  // mirrors the `void` action's ConfirmDialog guard in this same file.
  const [confirmAction, setConfirmAction] = useState<{ inv: InvoiceRow; kind: 'wallet' | 'text' } | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: invoices, isError, refetch } = useQuery<InvoiceRow[]>({
    queryKey: ['marketing', 'invoices'],
    queryFn: () => marketingApi.get('/invoices').then((r) => r.data),
    refetchInterval: 20_000,
  });
  const { data: pspCfg } = useQuery({
    queryKey: ['marketing', 'invoices', 'psp'],
    queryFn: () => marketingApi.get('/invoices/psp').then((r) => r.data),
  });

  // ── Invalidation ──────────────────────────────────────────────────────────
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'invoices'] });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const create = useMutation({
    mutationFn: (payload: {
      currency: string;
      notes?: string;
      items: { description: string; qty: number; unitPrice: number }[];
    }) => marketingApi.post('/invoices', payload),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      toast.success(t('invoices.created', 'Invoice created'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('invoices.saveFailed', 'Save failed')),
  });

  const send = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/send`),
    onSuccess: ({ data }) => {
      invalidate();
      navigator.clipboard.writeText(data.payUrl);
      toast.success(t('invoices.sent', 'Sent — pay link copied'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('invoices.sendFailed', { defaultValue: 'Could not send the invoice' })),
  });

  const markPaid = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/mark-paid`),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('invoices.markPaidFailed', { defaultValue: 'Could not mark the invoice as paid' })),
  });

  // Text-to-pay: send the public pay link to the contact via SMS.
  const textToPay = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/text-to-pay`, { channel: 'SMS' }),
    onSuccess: () => { invalidate(); setConfirmAction(null); toast.success(t('invoices.texted', { defaultValue: 'Pay link sent' })); },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('invoices.textFailed', { defaultValue: 'Could not send' })),
  });

  // Settle the invoice from the contact's store-credit wallet.
  const payWallet = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/pay-with-wallet`),
    onSuccess: () => { invalidate(); setConfirmAction(null); toast.success(t('invoices.paidWallet', { defaultValue: 'Paid from wallet' })); },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('invoices.walletFailed', { defaultValue: 'Wallet payment failed' })),
  });

  const voidInv = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/invoices/${id}/void`),
    onSuccess: () => {
      invalidate();
      setVoidTarget(null);
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('invoices.voidFailed', { defaultValue: 'Could not void the invoice' })),
  });

  const savePsp = useMutation({
    mutationFn: () =>
      marketingApi.put('/invoices/psp', {
        provider: psp.provider,
        secrets:
          psp.provider === 'STRIPE' && psp.secretKey
            ? { secretKey: psp.secretKey }
            : psp.provider === 'IYZICO' && (psp.apiKey || psp.secretKey)
              ? {
                  ...(psp.apiKey ? { apiKey: psp.apiKey } : {}),
                  ...(psp.secretKey ? { secretKey: psp.secretKey } : {}),
                }
              : psp.provider === 'PAYTR' && (psp.merchantId || psp.merchantKey || psp.merchantSalt)
                ? {
                    ...(psp.merchantId ? { merchantId: psp.merchantId } : {}),
                    ...(psp.merchantKey ? { merchantKey: psp.merchantKey } : {}),
                    ...(psp.merchantSalt ? { merchantSalt: psp.merchantSalt } : {}),
                  }
                : undefined,
        configPublic:
          psp.provider === 'MANUAL' && psp.instructions
            ? { instructions: psp.instructions }
            : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'invoices', 'psp'] });
      setPsp((p) => ({ ...p, secretKey: '', merchantKey: '', merchantSalt: '', apiKey: '' }));
      toast.success(t('invoices.pspSaved', 'Payment settings saved'));
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? t('invoices.pspSaveFailed', { defaultValue: 'Could not save payment settings' })),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('invoices.title', 'Invoices')}
        description={t(
          'invoices.subtitle',
          'Bill your customers and collect via your own Stripe or bank transfer.',
        )}
        actions={
          !showForm && (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('invoices.new', 'New invoice')}
            </Button>
          )
        }
      />

      {/* PSP settings */}
      <Card>
        <CardHeader>
          <CardTitle>{t('invoices.payments', 'How you get paid')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            {/* Provider */}
            <div className="w-52">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t('invoices.provider', 'Provider')}
              </p>
              <Select
                value={psp.provider}
                onValueChange={(v) => setPsp((p) => ({ ...p, provider: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MANUAL">
                    {t('invoices.manual', 'Bank transfer (manual)')}
                  </SelectItem>
                  <SelectItem value="STRIPE">Stripe</SelectItem>
                  <SelectItem value="PAYTR">PayTR (TRY)</SelectItem>
                  <SelectItem value="IYZICO">iyzico (TRY)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Stripe secret key / PayTR merchant creds / manual instructions */}
            {psp.provider === 'STRIPE' ? (
              <div className="flex-1 min-w-48">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t('invoices.stripeKey', 'Your Stripe secret key')}{' '}
                  {pspCfg?.configuredSecrets?.includes('secretKey') && (
                    <span className="text-success">✓ set</span>
                  )}
                </p>
                <Input
                  type="password"
                  value={psp.secretKey}
                  onChange={(e) => setPsp((p) => ({ ...p, secretKey: e.target.value }))}
                  placeholder="sk_live_…"
                  autoComplete="off"
                />
              </div>
            ) : psp.provider === 'PAYTR' ? (
              <div className="flex flex-1 min-w-48 flex-wrap gap-2">
                <div className="min-w-36 flex-1">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('invoices.paytrId', 'Merchant ID')}{' '}
                    {pspCfg?.configuredSecrets?.includes('merchantId') && <span className="text-success">✓</span>}
                  </p>
                  <Input value={psp.merchantId} onChange={(e) => setPsp((p) => ({ ...p, merchantId: e.target.value }))} placeholder="123456" autoComplete="off" />
                </div>
                <div className="min-w-36 flex-1">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('invoices.paytrKey', 'Merchant Key')}{' '}
                    {pspCfg?.configuredSecrets?.includes('merchantKey') && <span className="text-success">✓</span>}
                  </p>
                  <Input type="password" value={psp.merchantKey} onChange={(e) => setPsp((p) => ({ ...p, merchantKey: e.target.value }))} placeholder="••••" autoComplete="off" />
                </div>
                <div className="min-w-36 flex-1">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('invoices.paytrSalt', 'Merchant Salt')}{' '}
                    {pspCfg?.configuredSecrets?.includes('merchantSalt') && <span className="text-success">✓</span>}
                  </p>
                  <Input type="password" value={psp.merchantSalt} onChange={(e) => setPsp((p) => ({ ...p, merchantSalt: e.target.value }))} placeholder="••••" autoComplete="off" />
                </div>
              </div>
            ) : psp.provider === 'IYZICO' ? (
              <div className="flex flex-1 min-w-48 flex-wrap gap-2">
                <div className="min-w-36 flex-1">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('invoices.iyzicoApiKey', 'API key')}{' '}
                    {pspCfg?.configuredSecrets?.includes('apiKey') && <span className="text-success">✓</span>}
                  </p>
                  <Input value={psp.apiKey} onChange={(e) => setPsp((p) => ({ ...p, apiKey: e.target.value }))} placeholder="sandbox-…" autoComplete="off" />
                </div>
                <div className="min-w-36 flex-1">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('invoices.iyzicoSecretKey', 'Secret key')}{' '}
                    {pspCfg?.configuredSecrets?.includes('secretKey') && <span className="text-success">✓</span>}
                  </p>
                  <Input type="password" value={psp.secretKey} onChange={(e) => setPsp((p) => ({ ...p, secretKey: e.target.value }))} placeholder="••••" autoComplete="off" />
                </div>
              </div>
            ) : (
              <div className="flex-1 min-w-48">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t('invoices.instructions', 'Payment instructions (shown to payer)')}
                </p>
                <Input
                  value={psp.instructions}
                  onChange={(e) => setPsp((p) => ({ ...p, instructions: e.target.value }))}
                  placeholder="IBAN TR.. — Acme Ltd"
                />
              </div>
            )}

            <Button
              variant="secondary"
              loading={savePsp.isPending}
              onClick={() => savePsp.mutate()}
            >
              {t('common.save', 'Save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* New invoice form */}
      {showForm && (
        <InvoiceForm
          isPending={create.isPending}
          onSubmit={(payload) => create.mutate(payload)}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Error state */}
      <QueryStateBoundary
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('common.loadError', 'Could not load. Please try again.')}
      />

      {/* Invoice list */}
      {!isError && ((invoices?.length ?? 0) === 0 && !showForm ? (
        <EmptyState
          icon={<FileText className="h-8 w-8" />}
          title={t('invoices.empty', 'No invoices yet.')}
          description={t(
            'invoices.emptyHint',
            'Create your first invoice to start billing customers.',
          )}
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('invoices.new', 'New invoice')}
            </Button>
          }
        />
      ) : (invoices?.length ?? 0) > 0 ? (
        <Card>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>{t('invoices.number', 'Invoice #')}</TH>
                  <TH>{t('invoices.status', 'Status')}</TH>
                  <TH numeric>{t('invoices.total', 'Total')}</TH>
                  <TH className="hidden sm:table-cell">
                    {t('invoices.date', 'Date')}
                  </TH>
                  <TH className="w-28 text-end">{t('invoices.actions', 'Actions')}</TH>
                </TR>
              </THead>
              <TBody>
                {(invoices ?? []).map((inv) => (
                  <TR key={inv.id}>
                    <TD className="font-medium text-foreground">
                      <span className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-primary shrink-0" aria-hidden />
                        {inv.number}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={invoiceStatusTone(inv.status)} size="sm">
                        {inv.status}
                      </Badge>
                    </TD>
                    <TD numeric className="text-foreground">
                      {/* inv.total is stored in cents — display in major unit */}
                      {(inv.total / 100).toLocaleString()} {inv.currency}
                    </TD>
                    <TD className="hidden sm:table-cell text-xs text-muted-foreground">
                      {new Date(inv.createdAt).toLocaleDateString()}
                    </TD>
                    <TD>
                      {inv.status !== 'PAID' && inv.status !== 'VOID' && (
                        <div className="flex items-center justify-end gap-1">
                          {/* Each financial action's in-flight guard is scoped
                              to THIS invoice (mutation.variables === inv.id) so a
                              double-click can't double-fire a pay/mark-paid, and
                              acting on one invoice doesn't disable the same button
                              on the others. */}
                          <button
                            onClick={() => send.mutate(inv.id)}
                            disabled={send.isPending && send.variables === inv.id}
                            title={t('invoices.send', 'Send / copy pay link')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                          >
                            <Clipboard className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            onClick={() => setConfirmAction({ inv, kind: 'text' })}
                            disabled={textToPay.isPending && textToPay.variables === inv.id}
                            title={t('invoices.textToPay', 'Text pay link (SMS)')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                          >
                            <MessageSquare className="h-4 w-4" aria-hidden />
                          </button>
                          {/* Store-credit wallets are TRY-only, so pay-from-wallet
                              is offered only for a TRY invoice — the backend refuses
                              a cross-currency debit, so don't present a doomed action. */}
                          {inv.currency === 'TRY' && (
                            <button
                              onClick={() => setConfirmAction({ inv, kind: 'wallet' })}
                              disabled={payWallet.isPending && payWallet.variables === inv.id}
                              title={t('invoices.payWithWallet', 'Pay from store credit')}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                            >
                              <Wallet className="h-4 w-4" aria-hidden />
                            </button>
                          )}
                          <button
                            onClick={() => markPaid.mutate(inv.id)}
                            disabled={markPaid.isPending && markPaid.variables === inv.id}
                            title={t('invoices.markPaid', 'Mark paid')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-success hover:bg-success-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                          >
                            <CheckCircle className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            onClick={() => setVoidTarget(inv)}
                            title={t('invoices.void', 'Void invoice')}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-danger-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      ) : null)}

      {/* Confirm void */}
      <ConfirmDialog
        open={!!voidTarget}
        onOpenChange={(open) => { if (!open) setVoidTarget(null); }}
        title={t('invoices.voidTitle', 'Void invoice?')}
        description={
          voidTarget
            ? t(
                'invoices.voidDesc',
                'Void invoice {{number}}? This cannot be undone.',
                { number: voidTarget.number },
              )
            : undefined
        }
        confirmLabel={t('invoices.void', 'Void')}
        tone="danger"
        onConfirm={() => voidTarget && voidInv.mutate(voidTarget.id)}
        loading={voidInv.isPending}
      />

      {/* Confirm the two consequential actions: an irreversible wallet debit and
          a billable outbound SMS. Distinct confirm labels (not the icon buttons'
          titles) so the modal button is unambiguous. */}
      <ConfirmDialog
        open={!!confirmAction}
        onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
        title={
          confirmAction?.kind === 'wallet'
            ? t('invoices.payWalletTitle', 'Pay from store credit?')
            : t('invoices.textToPayTitle', 'Text the pay link?')
        }
        description={
          confirmAction?.kind === 'wallet'
            ? t(
                'invoices.payWalletDesc',
                'Debit {{amount}} {{currency}} from the contact’s store credit to settle invoice {{number}}? This cannot be undone.',
                {
                  amount: (confirmAction.inv.total / 100).toLocaleString(),
                  currency: confirmAction.inv.currency,
                  number: confirmAction.inv.number,
                },
              )
            : confirmAction?.kind === 'text'
              ? t(
                  'invoices.textToPayDesc',
                  'Send invoice {{number}}’s pay link to the contact by SMS?',
                  { number: confirmAction.inv.number },
                )
              : undefined
        }
        confirmLabel={
          confirmAction?.kind === 'wallet'
            ? t('invoices.payWalletConfirm', 'Pay now')
            : t('invoices.textToPayConfirm', 'Send SMS')
        }
        tone={confirmAction?.kind === 'wallet' ? 'danger' : 'default'}
        loading={confirmAction?.kind === 'wallet' ? payWallet.isPending : textToPay.isPending}
        onConfirm={() => {
          if (!confirmAction) return;
          if (confirmAction.kind === 'wallet') payWallet.mutate(confirmAction.inv.id);
          else textToPay.mutate(confirmAction.inv.id);
        }}
      />
    </div>
  );
}
