import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { hasMarketingRole, MarketingRole } from '../types';
import { useWorkspaceProfile } from '../hooks/useWorkspaceProfile';
import { useLocations, useLocationMutations } from '../../../pages/marketing/agency/hooks';
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
 * Top-bar workspace switcher — multi-workspace membership, plus an agency's
 * sub-accounts.
 *
 * Renders nothing for the overwhelming majority of users, who belong to exactly
 * one workspace (the Phase-0 backfill migration gives every existing user a
 * single membership): a single-item dropdown would only add noise. Only a user
 * who has created or been invited into a second workspace sees it.
 *
 * ## Why the agency's sub-accounts are here and not only on /agency/locations
 *
 * A sub-account is NOT a membership — it is a separate workspace the agency
 * owner mints a session into (`POST /agency/locations/:id/access`), which is
 * why the count above says nothing about it. So an agency operator whose single
 * membership hid this control had exactly one route to the act they perform
 * several times a day: navigate to /agency/locations, a page in the SETTINGS
 * area, i.e. through the gear, every time. Switching in is daily work; setting a
 * sub-account up is not, and that half stays on the page.
 *
 * The `impersonating` guard above is untouched and stays FIRST. The banner is
 * the way back out of a sub-account, and the two session-swap flows — agency
 * impersonation and multi-workspace switching — must not tangle over the same
 * token slots. Once you are inside a location you leave the way you came.
 */
export function WorkspaceSwitcher() {
  const { t } = useTranslation('marketing');
  const memberships = useMarketingAuthStore((s) => s.memberships);
  const user = useMarketingAuthStore((s) => s.user);
  const activeWorkspaceId = useMarketingAuthStore((s) => s.user?.workspaceId);
  const switchWorkspace = useMarketingAuthStore((s) => s.switchWorkspace);
  const impersonating = useMarketingAuthStore((s) => !!s.agencyReturn);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isSwitching, setIsSwitching] = useState(false);
  const { isAgency } = useWorkspaceProfile();
  const isAgencyOwner = isAgency && hasMarketingRole(user?.role, MarketingRole.OWNER);
  // `/agency/locations` is AGENCY-OWNER gated server-side, so the read only
  // runs for someone it will answer. Shares the agency console's key: a manager
  // who opens that page later gets this list from cache.
  const locationsQ = useLocations(isAgencyOwner);
  const { access } = useLocationMutations();
  const locations = isAgencyOwner ? (locationsQ.data ?? []) : [];

  // An agency operator impersonating a sub-account (agencyReturn set) must
  // not also be able to switch between their OWN workspaces — the two
  // session-swap flows (impersonation vs. multi-workspace) would tangle
  // over the same token slots in the store. Checked before the membership
  // count so it wins even when the user has more than one membership.
  if (impersonating) return null;
  // `isAgency` fails CLOSED while the profile is in flight, so a standalone
  // workspace never flashes a switcher it does not have.
  if (!isAgency && (!memberships || memberships.length <= 1)) return null;

  const activeMembership = memberships?.find((m) => m.workspaceId === activeWorkspaceId);

  const onSelect = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId || isSwitching) return;
    setIsSwitching(true);
    try {
      await switchWorkspace(workspaceId);
      // Every cached query (leads, campaigns, dashboards…) belongs to the
      // PREVIOUS workspace — clear the cache wholesale rather than trying to
      // invalidate it query-key by query-key.
      queryClient.clear();
      navigate('/home');
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
          className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-muted px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:px-3"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="max-w-[6rem] truncate sm:max-w-[10rem]">
            {activeMembership?.workspaceName ?? 'Workspace'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(memberships ?? []).map((m) => {
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

        {/* The daily agency act, one click from any screen. `access.mutate`
            is the console's own mutation — it mints the location session,
            calls `enterLocation` (which lights the impersonation banner) and
            clears the cache — so this duplicates none of that logic and cannot
            drift from it. The banner is then the only way back, which is why
            this whole control disappears while impersonating. */}
        {locations.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t('agency.switcher.subAccounts', 'Alt hesaplar')}
            </DropdownMenuLabel>
            {locations.map((loc) => (
              <DropdownMenuItem
                key={loc.id}
                data-testid={`switch-sub-account-${loc.id}`}
                disabled={access.isPending}
                onSelect={() => access.mutate({ id: loc.id, name: loc.name })}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{loc.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default WorkspaceSwitcher;
