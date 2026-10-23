import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { listAgents } from '@/api/agents';
import type { AgentConnectionOut } from '@/api/types';
import { QueryState } from '@/components/QueryState';
import { DataTable, EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';

export function AgentsPage() {
  const { t, i18n } = useTranslation();
  const agents = useQuery({ queryKey: ['agents'], queryFn: listAgents });

  const columns = useMemo<ColumnDef<AgentConnectionOut, unknown>[]>(() => {
    const when = (iso: string) => (
      <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(iso, i18n.language)}</span>
    );
    return [
      {
        id: 'client',
        header: t('agents.columns.client'),
        accessorKey: 'client_name',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.client_name}</span>,
      },
      {
        id: 'version',
        header: t('agents.columns.version'),
        accessorKey: 'client_version',
        cell: ({ row }) => <span className="font-mono text-caption">{row.original.client_version}</span>,
      },
      {
        id: 'protocol',
        header: t('agents.columns.protocol'),
        accessorKey: 'protocol_version',
        cell: ({ row }) => <span className="font-mono text-caption">{row.original.protocol_version}</span>,
      },
      {
        id: 'key',
        header: t('agents.columns.key'),
        accessorKey: 'api_key_name',
      },
      {
        id: 'firstSeen',
        header: t('agents.columns.firstSeen'),
        accessorKey: 'first_seen_at',
        cell: ({ row }) => when(row.original.first_seen_at),
      },
      {
        id: 'lastSeen',
        header: t('agents.columns.lastSeen'),
        accessorKey: 'last_seen_at',
        cell: ({ row }) => when(row.original.last_seen_at),
      },
      {
        id: 'toolCalls',
        header: t('agents.columns.toolCalls'),
        accessorKey: 'tool_calls',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatNumber(row.original.tool_calls, i18n.language)}</span>
        ),
      },
    ];
  }, [t, i18n.language]);

  return (
    <>
      <PageHeader title={t('agents.title')} description={t('agents.description')} />
      <QueryState query={agents}>
        <DataTable
          columns={columns}
          data={agents.data ?? []}
          emptyState={<EmptyState title={t('agents.empty')} description={t('agents.emptyBody')} />}
        />
      </QueryState>
    </>
  );
}
