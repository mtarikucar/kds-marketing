import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBilling, type BillingStatus } from '@/api/billing';
import { useSession } from '@/auth/useSession';

export function useBilling(page: 'billing' | 'onboarding') {
  const client = useQueryClient();
  const workspace = useSession().data?.current_workspace;
  const queryKey = ['billing', page, workspace] as const;
  const query = useQuery({ queryKey, queryFn: ({ signal }) => getBilling(signal),
    enabled: !!workspace, staleTime: 0, gcTime: 0 });
  useEffect(() => () => {
    client.removeQueries({ queryKey: ['billing', page, workspace], exact: true });
  }, [client, page, workspace]);
  return query;
}

export function billingStage(status: BillingStatus) {
  if (status.workspace_status !== 'pending_payment') return status.workspace_status;
  if (status.entitlement && !status.entitlement.revoked_at) return 'activation';
  if (status.payment && !status.payment.confirmed) return 'approval';
  return 'pending_payment';
}
