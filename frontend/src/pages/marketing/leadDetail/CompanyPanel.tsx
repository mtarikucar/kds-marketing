import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2 } from 'lucide-react';
import { listCompanies, type Company } from '../../../features/marketing/api/companies.service';
import { setLeadCompany } from '../../../features/marketing/api/leads.service';
import { Card, CardContent } from '@/components/ui/Card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';

const NONE = '__none__';

/**
 * Lead-detail panel: link the contact to a B2B company (Epic 6). A select of the
 * workspace's companies; choosing one PATCHes lead.companyId, "No company"
 * unlinks. Mirrors the WalletPanel placement in the left column.
 */
export function CompanyPanel({ leadId, companyId, onUpdated }: { leadId: string; companyId: string | null | undefined; onUpdated: () => void }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const { data: companies } = useQuery<Company[]>({
    queryKey: ['marketing', 'companies'],
    queryFn: () => listCompanies(),
  });

  const link = useMutation({
    mutationFn: (value: string) => setLeadCompany(leadId, value === NONE ? '' : value),
    onSuccess: () => {
      onUpdated();
      qc.invalidateQueries({ queryKey: ['marketing', 'companies'] });
      toast.success(t('companies.linked', 'Company updated'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('companies.linkFailed', 'Could not update company')),
  });

  const current = companies?.find((c) => c.id === companyId);

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('companies.company', 'Company')}
        </div>
        <Select value={companyId ?? NONE} onValueChange={(v) => link.mutate(v)} disabled={link.isPending}>
          <SelectTrigger><SelectValue placeholder={t('companies.selectCompany', 'No company')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('companies.none', 'No company')}</SelectItem>
            {(companies ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current && (
          <Link to="/companies" className="text-caption text-primary hover:underline inline-block">
            {t('companies.viewAccount', 'View account →')}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
