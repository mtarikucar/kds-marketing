import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../api/marketingApi';
import { getStrategy } from '../api/strategy.service';
import {
  getOnboarding,
  setOnboardingDismissed,
  ONBOARDING_QUERY_KEY,
} from '../api/onboarding.service';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

export interface ChecklistStep {
  id: string;
  to: string;
  done: boolean;
  /**
   * An i18n key for a caveat this step carries RIGHT NOW, or undefined.
   *
   * Conditional rather than baked into the step's copy: a warning that is
   * always on screen is a warning nobody reads, and this one only applies while
   * the workspace is on `APPROVAL` MCP write mode.
   */
  warningKey?: string;
}

export interface OnboardingChecklist {
  /** True when the checklist should be shown at all (manager, not dismissed). */
  active: boolean;
  steps: ChecklistStep[];
  done: number;
  total: number;
  allDone: boolean;
  /** True when there is still setup to do AND the user can see it. */
  incomplete: boolean;
  dismiss: () => void;
}

/**
 * The first-run setup checklist's state, derived from real workspace data.
 *
 * Extracted from GettingStarted so the DASHBOARD can also read it. The page
 * needs to know whether setup is still outstanding in order to decide what to
 * put first: an unconfigured workspace was being shown "add your first lead"
 * above the checklist, which is the wrong opening instruction for a product
 * whose whole premise is that the AI strategist decides what to do. The
 * component alone could not express that — it returned null internally and the
 * page had no way to see it.
 *
 * Each query reuses the owning page's exact query key, so the cache is shared
 * and nothing is fetched twice.
 */
export function useOnboardingChecklist(): OnboardingChecklist {
  const { user } = useMarketingAuthStore();
  const qc = useQueryClient();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  // Dismissal is a WORKSPACE fact, not a per-device opinion. It used to live in
  // localStorage, so putting the guide away on a laptop left it waiting on a
  // phone, clearing site data nagged a fully configured workspace again, and a
  // second team member saw a guide the owner had already worked through.
  const state = useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: getOnboarding,
    enabled: isManager,
    staleTime: 60_000,
  });
  const setDismissed = useMutation({
    mutationFn: setOnboardingDismissed,
    // Optimistic: dismissing must feel instant, and the checklist unmounting is
    // the confirmation. A refetch on settle keeps the server authoritative.
    onMutate: async (next: boolean) => {
      await qc.cancelQueries({ queryKey: ONBOARDING_QUERY_KEY });
      const prev = qc.getQueryData(ONBOARDING_QUERY_KEY);
      // MERGE, never replace. This payload carries two other workspace facts
      // (`claudeLaneProven`, `mcpWriteMode`) that dismissal does not touch, and
      // overwriting the cache with `{ dismissed }` alone would blank them until
      // the refetch — flickering completed steps back to incomplete on the way
      // out.
      qc.setQueryData(ONBOARDING_QUERY_KEY, (old: unknown) =>
        old && typeof old === 'object' ? { ...(old as object), dismissed: next } : { dismissed: next },
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(ONBOARDING_QUERY_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY }),
  });

  // Until the flag has loaded, treat the guide as dismissed: showing it and
  // then yanking it away is worse than showing it a beat late.
  const dismissed = state.data?.dismissed ?? true;
  const active = isManager && !dismissed;

  // getStrategy swallows a 404 into null, so a strategy-less workspace simply
  // reads as not-done — no rejected query to special-case.
  const strategy = useQuery({
    queryKey: ['marketing', 'strategy'],
    queryFn: getStrategy,
    enabled: active,
  });
  const channels = useQuery<any[]>({
    queryKey: ['marketing', 'channels'],
    queryFn: () => marketingApi.get('/channels').then((r) => r.data),
    enabled: active,
  });
  const team = useQuery<any[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: active,
    staleTime: 60_000,
  });

  /**
   * FOUR steps, down from eight and back up by one.
   *
   * The old checklist demanded agent, knowledge, brand brain, a first lead and
   * a published site as separate chores. Every one of those is now a BYPRODUCT
   * of the strategy: intake starts the Brand Brain from the same material and
   * auto-applies it (brand profile + knowledge docs + research profile), the
   * synthesis provisions the default agent, and the research agent generates
   * leads on its own. Listing them as steps was asking the user to do the
   * system's job — the exact complexity complaint this flow exists to answer.
   *
   * What remains is what only a human CAN do: describe the business (strategy),
   * plug in where customers talk to them (channel), bring their people (team)
   * — and connect their own Claude.
   *
   * THAT FOURTH STEP EARNS ITS PLACE for a reason none of the deleted ones
   * could: research is 86% of the platform's measured model bill, and it is the
   * one thing the customer can move onto their own subscription. It is also the
   * step most likely to be left half-done, which is why its completion is
   * `claudeLaneProven` — a real `claim_research_job` having succeeded — and not
   * "a key exists". A key with no scheduled task behind it looks identical to a
   * working lane from every other angle, and ticking the step for it would mean
   * the checklist certifies exactly the broken setup it exists to prevent.
   */
  const steps: ChecklistStep[] = [
    {
      id: 'strategy',
      to: '/onboarding/strategy',
      done: !!(strategy.data?.id || strategy.data?.archetype),
    },
    { id: 'channel', to: '/inbox?tab=channels', done: (channels.data?.length ?? 0) > 0 },
    // "Invite your team" — done once there's more than just the owner.
    { id: 'team', to: '/users', done: (team.data?.length ?? 0) > 1 },
    {
      id: 'claude',
      // The connector console: the MCP address, the key, and the copy-paste
      // scheduled-task prompt all live on one page there.
      to: '/settings/mcp-console',
      done: state.data?.claudeLaneProven === true,
      // Only while it applies. Under APPROVAL the three Jeeta-keyed data tools
      // are not delayed, they are UNUSABLE (the approval executor returns their
      // result to the approver's HTTP response, never to the agent's turn), so
      // the lane silently degrades to plain web search and loses the Google
      // Maps pain signal it was designed around. Someone being walked through
      // setup has to know that before they finish.
      warningKey:
        state.data?.mcpWriteMode === 'APPROVAL' ? 'onboarding.steps.claude.approvalWarning' : undefined,
    },
  ];

  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const allDone = done === total;

  // Latch dismissal once fully set up, so it stays gone on reload even if a
  // setup item is later removed.
  useEffect(() => {
    if (active && allDone && !setDismissed.isPending) setDismissed.mutate(true);
    // `setDismissed` is a stable mutation object; depending on it would re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, allDone]);

  return {
    active,
    steps,
    done,
    total,
    allDone,
    incomplete: active && !allDone,
    dismiss: () => setDismissed.mutate(true),
  };
}
