import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import {
  Badge,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  cn,
} from '@/components/ui';

/**
 * Top-bar workspace switcher — multi-workspace membership. Renders nothing
 * for the overwhelming majority of users, who belong to exactly one
 * workspace (the Phase-0 backfill migration gives every existing user a
 * single membership): a single-item dropdown would only add noise. Only a
 * user who has created or been invited into a second workspace sees it.
 */
export function WorkspaceSwitcher() {
  const memberships = useMarketingAuthStore((s) => s.memberships);
  const activeWorkspaceId = useMarketingAuthStore((s) => s.user?.workspaceId);
  const switchWorkspace = useMarketingAuthStore((s) => s.switchWorkspace);
  const impersonating = useMarketingAuthStore((s) => !!s.agencyReturn);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isSwitching, setIsSwitching] = useState(false);

  // An agency operator impersonating a sub-account (agencyReturn set) must
  // not also be able to switch between their OWN workspaces — the two
  // session-swap flows (impersonation vs. multi-workspace) would tangle
  // over the same token slots in the store. Checked before the membership
  // count so it wins even when the user has more than one membership.
  if (impersonating) return null;
  if (!memberships || memberships.length <= 1) return null;

  const activeMembership = memberships.find((m) => m.workspaceId === activeWorkspaceId);

  const onSelect = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId || isSwitching) return;
    setIsSwitching(true);
    try {
      await switchWorkspace(workspaceId);
      // Every cached query (leads, campaigns, dashboards…) belongs to the
      // PREVIOUS workspace — clear the cache wholesale rather than trying to
      // invalidate it query-key by query-key.
      queryClient.clear();
      navigate('/dashboard');
    } catch {
      toast.error('Could not switch workspace. Please try again.');
    } finally {
      setIsSwitching(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isSwitching}
          className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="max-w-[10rem] truncate">
            {activeMembership?.workspaceName ?? 'Workspace'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((m) => {
          const isActive = m.workspaceId === activeWorkspaceId;
          return (
            <DropdownMenuItem
              key={m.workspaceId}
              onSelect={() => onSelect(m.workspaceId)}
              className={cn('flex items-center justify-between gap-2', isActive && 'bg-surface-muted')}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-primary',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{m.workspaceName}</span>
              </span>
              <Badge tone={m.role === 'OWNER' ? 'primary' : 'neutral'} size="sm">
                {m.role}
              </Badge>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default WorkspaceSwitcher;
