import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Building2, Trash2, Users, Target, MessagesSquare, Globe } from 'lucide-react';
import { useCreateParam } from '../../../features/marketing/hooks/useCreateParam';
import {
  listCompanies,
  getCompany,
  getCompanyContacts,
  createCompany,
  deleteCompany,
  type Company,
  type CompanyDetail,
  type CompanyContact,
} from '../../../features/marketing/api/companies.service';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/Dialog';

interface NewCompany { name: string; domain: string; phone: string; email: string; city: string }
const EMPTY: NewCompany = { name: '', domain: '', phone: '', email: '', city: '' };

export default function CompaniesPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<NewCompany>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);

  // Honor ?create=1 from the global "+ Create" menu / command palette.
  useCreateParam(() => setCreateOpen(true));

  const { data: companies } = useQuery<Company[]>({
    queryKey: ['marketing', 'companies', search],
    queryFn: () => listCompanies(search || undefined),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['marketing', 'companies'] });

  const create = useMutation({
    mutationFn: () => createCompany({
      name: form.name.trim(),
      domain: form.domain || undefined,
      phone: form.phone || undefined,
      email: form.email || undefined,
      city: form.city || undefined,
    }),
    onSuccess: () => { invalidate(); setCreateOpen(false); setForm(EMPTY); toast.success(t('companies.created', 'Company created')); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('companies.createFailed', 'Could not create company')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCompany(id),
    onSuccess: () => { invalidate(); setDeleteTarget(null); setSelectedId(null); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('companies.deleteFailed', 'Could not delete company')),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('companies.title', 'Companies')}
        description={t('companies.subtitle', 'Group your contacts into B2B accounts and roll up their deals.')}
        actions={
          <Button onClick={() => { setForm(EMPTY); setCreateOpen(true); }} size="md">
            <Plus className="h-4 w-4" />{t('companies.new', 'New company')}
          </Button>
        }
      />

      <Input
        placeholder={t('companies.search', 'Search companies…')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('companies.new', 'New company')}</DialogTitle>
            <DialogDescription>{t('companies.createHint', 'Add a B2B account, then link contacts to it.')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label={t('companies.name', 'Name')} required>
              {({ id }) => <Input id={id} value={form.name} maxLength={160} autoFocus onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('companies.domain', 'Domain')}>
                {({ id }) => <Input id={id} value={form.domain} placeholder="acme.com" onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} />}
              </Field>
              <Field label={t('companies.city', 'City')}>
                {({ id }) => <Input id={id} value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />}
              </Field>
              <Field label={t('companies.phone', 'Phone')}>
                {({ id }) => <PhoneInput id={id} value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />}
              </Field>
              <Field label={t('companies.email', 'Email')}>
                {({ id }) => <Input id={id} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />}
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim() || create.isPending}>
              {t('common.create', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <CompanyDetailDialog
        companyId={selectedId}
        onClose={() => setSelectedId(null)}
        onDelete={(c) => setDeleteTarget(c)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('companies.deleteTitle', 'Delete company?')}
        description={t('companies.deleteDesc', 'Its contacts are kept but unlinked from the company.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      {/* List */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {(companies ?? []).map((c) => (
          <Card key={c.id} className="cursor-pointer hover:border-primary transition-colors" onClick={() => setSelectedId(c.id)}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Building2 className="h-5 w-5 text-primary shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground truncate">{c.name}</div>
                  {c.domain && <div className="text-caption text-muted-foreground truncate">{c.domain}</div>}
                  <div className="mt-2 flex items-center gap-2">
                    <Badge tone="neutral" size="sm"><Users className="h-3 w-3 mr-0.5" />{c.contactCount ?? 0}</Badge>
                    {c.city && <span className="text-caption text-muted-foreground">{c.city}</span>}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(companies ?? []).length === 0 && (
        <EmptyState
          icon={<Building2 className="h-10 w-10" />}
          title={t('companies.emptyTitle', 'No companies yet')}
          description={t('companies.empty', 'Create a company to group contacts and roll up their deals.')}
          action={<Button onClick={() => { setForm(EMPTY); setCreateOpen(true); }}><Plus className="h-4 w-4" />{t('companies.new', 'New company')}</Button>}
        />
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">{icon}{label}</div>
      <div className="text-lg font-semibold text-foreground mt-0.5">{value}</div>
    </div>
  );
}

function CompanyDetailDialog({ companyId, onClose, onDelete }: { companyId: string | null; onClose: () => void; onDelete: (c: Company) => void }) {
  const { t } = useTranslation('marketing');
  const { data: company } = useQuery<CompanyDetail>({
    queryKey: ['marketing', 'companies', 'detail', companyId],
    queryFn: () => getCompany(companyId as string),
    enabled: !!companyId,
  });
  const { data: contacts } = useQuery<CompanyContact[]>({
    queryKey: ['marketing', 'companies', 'contacts', companyId],
    queryFn: () => getCompanyContacts(companyId as string),
    enabled: !!companyId,
  });

  return (
    <Dialog open={!!companyId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        {company && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Building2 className="h-5 w-5 text-primary" />{company.name}</DialogTitle>
              <DialogDescription>
                {[company.domain, company.city, company.phone].filter(Boolean).join(' · ') || t('companies.noDetails', 'No extra details')}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-3 gap-3">
              <Stat icon={<Users className="h-3.5 w-3.5" />} label={t('companies.contacts', 'Contacts')} value={company.contactCount} />
              <Stat icon={<Target className="h-3.5 w-3.5" />} label={t('companies.openDeals', 'Open deals')} value={company.openOpportunities} />
              <Stat icon={<MessagesSquare className="h-3.5 w-3.5" />} label={t('companies.conversations', 'Conversations')} value={company.conversationCount} />
            </div>
            <div className="text-sm text-muted-foreground">
              {t('companies.openValue', 'Open pipeline value')}: <span className="font-medium text-foreground">{Number(company.openValue).toLocaleString()}</span>
            </div>

            <div className="max-h-72 overflow-y-auto space-y-1.5">
              <div className="text-caption text-muted-foreground">{t('companies.linkedContacts', 'Linked contacts')}</div>
              {(contacts ?? []).map((c) => (
                <Link key={c.id} to={`/leads/${c.id}`} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2 hover:bg-surface-muted text-sm">
                  <span className="truncate">{c.contactPerson} <span className="text-muted-foreground">· {c.businessName}</span></span>
                  <Badge tone="neutral" size="sm">{c.status}</Badge>
                </Link>
              ))}
              {(contacts ?? []).length === 0 && (
                <p className="text-caption text-muted-foreground py-2">{t('companies.noContacts', 'No contacts linked yet. Link one from a contact’s detail page.')}</p>
              )}
            </div>

            <DialogFooter className="flex items-center justify-between">
              <IconButton variant="ghost" size="sm" aria-label={t('common.delete', 'Delete')} className="text-danger hover:bg-danger-subtle mr-auto" onClick={() => onDelete(company)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
              {company.domain && (
                <Button asChild variant="outline" size="sm">
                  <a href={`https://${company.domain.trim().replace(/^https?:\/\//i, '')}`} target="_blank" rel="noreferrer noopener">
                    <Globe className="h-3.5 w-3.5" />{t('companies.visit', 'Visit site')}
                  </a>
                </Button>
              )}
              <Button onClick={onClose}>{t('common.close', 'Close')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
