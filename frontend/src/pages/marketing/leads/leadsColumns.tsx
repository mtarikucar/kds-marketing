import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { LeadStatusBadge, AssignCell } from '../../../features/marketing/components';
import {
  BusinessType,
  LeadSource,
  BUSINESS_TYPE_LABELS,
  LEAD_SOURCE_LABELS,
} from '../../../features/marketing/types';
import type { Lead } from '../../../features/marketing/types';
import { fmtDate } from '../../../features/marketing/utils/format';

/** Source → Badge tone map (best-effort; neutral fallback). */
const SOURCE_TONE: Record<string, 'neutral' | 'primary' | 'info' | 'warning' | 'success' | 'danger'> = {
  INSTAGRAM: 'primary',
  REFERRAL: 'success',
  FIELD_VISIT: 'info',
  ADS: 'warning',
  WEBSITE: 'primary',
  PHONE: 'neutral',
  OTHER: 'neutral',
  AI_RESEARCH: 'info',
};

/**
 * Returns column definitions for the Leads DataTable.
 * `isManager` controls whether the Assign column is editable.
 *
 * Note: `t` must be passed from the consuming component to ensure i18n context.
 */
export function buildLeadsColumns(
  t: ReturnType<typeof useTranslation<'marketing'>>['t'],
  isManager: boolean,
): ColumnDef<Lead, unknown>[] {
  const cols: ColumnDef<Lead, unknown>[] = [
    {
      id: 'businessName',
      accessorKey: 'businessName',
      header: t('leads.table.business'),
      enableSorting: true,
      cell: ({ row }) => {
        const lead = row.original;
        const typeLabel = t(`businessType.${lead.businessType}`, {
          defaultValue: BUSINESS_TYPE_LABELS[lead.businessType as BusinessType] || lead.businessType,
        });
        return (
          <div>
            <p className="font-medium text-foreground">{lead.businessName}</p>
            <p className="text-micro text-muted-foreground mt-0.5">{typeLabel}</p>
          </div>
        );
      },
    },
    {
      id: 'source',
      accessorKey: 'source',
      header: t('leads.table.source'),
      enableSorting: false,
      cell: ({ row }) => {
        const lead = row.original;
        const label = t(`source.${lead.source}`, {
          defaultValue: LEAD_SOURCE_LABELS[lead.source as LeadSource] || lead.source,
        });
        return (
          <Badge tone={SOURCE_TONE[lead.source] ?? 'neutral'} size="sm">
            {label}
          </Badge>
        );
      },
    },
    {
      id: 'city',
      accessorKey: 'city',
      header: t('leads.table.city'),
      enableSorting: true,
      cell: ({ row }) => (
        <span className="text-sm text-foreground">
          {row.original.city || <span className="text-muted-foreground">—</span>}
        </span>
      ),
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: t('leads.table.status'),
      enableSorting: false,
      cell: ({ row }) => <LeadStatusBadge status={row.original.status} />,
    },
    {
      id: 'assignedTo',
      header: t('leads.table.assignedTo'),
      enableSorting: false,
      cell: ({ row }) => (
        <AssignCell
          leadId={row.original.id}
          currentAssignee={row.original.assignedTo ?? null}
          readOnly={!isManager}
        />
      ),
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: t('leads.table.createdAt'),
      enableSorting: true,
      cell: ({ row }) => (
        <span className="text-caption text-muted-foreground">
          {fmtDate(row.original.createdAt)}
        </span>
      ),
    },
  ];

  return cols;
}
