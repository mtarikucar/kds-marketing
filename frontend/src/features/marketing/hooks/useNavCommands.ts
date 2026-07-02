import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useEntitlements } from './useEntitlements';
import { useWorkspaceProfile } from './useWorkspaceProfile';
import { NAV_HUBS, visibleNav } from '../navigation';

/** A single navigable destination the command palette can jump to. */
export interface NavCommand {
  /** Stable id / React key (the path). */
  id: string;
  /** Localized page label. */
  label: string;
  /** Localized owning-hub label (null for single-page hubs like Dashboard). */
  hubLabel: string | null;
  /** Router path. */
  path: string;
  icon?: LucideIcon;
}

/**
 * Flattens the SAME role/plan/agency-gated navigation the sidebar renders
 * (`visibleNav(NAV_HUBS, …)`) into a flat list of destinations for the command
 * palette. Because it reuses `visibleNav`, the palette can never jump a user to
 * a page their role/plan can't see. Deduped by path (each page lives in exactly
 * one hub, but the Set guards against future overlap).
 */
export function useNavCommands(): NavCommand[] {
  const { t } = useTranslation('marketing');
  const user = useMarketingAuthStore((s) => s.user);
  const { has } = useEntitlements();
  const { isAgency } = useWorkspaceProfile();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  return useMemo(() => {
    const hubs = visibleNav(NAV_HUBS, { isManager, has, isAgency });
    const commands: NavCommand[] = [];
    const seen = new Set<string>();
    const push = (c: NavCommand) => {
      if (seen.has(c.path)) return;
      seen.add(c.path);
      commands.push(c);
    };
    for (const hub of hubs) {
      const hubLabel = t(hub.labelKey, hub.label);
      if (hub.children && hub.children.length > 0) {
        for (const child of hub.children) {
          push({
            id: child.path,
            label: t(child.labelKey, child.label),
            hubLabel,
            path: child.path,
            icon: child.icon ?? hub.icon,
          });
        }
      } else if (hub.path) {
        push({ id: hub.path, label: hubLabel, hubLabel: null, path: hub.path, icon: hub.icon });
      }
    }
    return commands;
    // `has` and `isAgency` come from cached queries; include primitives that
    // actually change the output. `t` is stable per language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager, isAgency, t, has]);
}
