import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../api/marketingApi';
import { getBrandProfile } from '../api/brandBrain.service';
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
      qc.setQueryData(ONBOARDING_QUERY_KEY, { dismissed: next });
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
  const agents = useQuery<any[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
    enabled: active,
  });
  const docs = useQuery<any[]>({
    queryKey: ['marketing', 'ai', 'knowledge'],
    queryFn: () => marketingApi.get('/ai/knowledge').then((r) => r.data),
    enabled: active,
  });
  const brandProfile = useQuery({
    queryKey: ['marketing', 'brand-brain', 'profile'],
    queryFn: getBrandProfile,
    enabled: active,
  });
  const channels = useQuery<any[]>({
    queryKey: ['marketing', 'channels'],
    queryFn: () => marketingApi.get('/channels').then((r) => r.data),
    enabled: active,
  });
  const sites = useQuery<any[]>({
    queryKey: ['marketing', 'sites'],
    queryFn: () => marketingApi.get('/sites').then((r) => r.data),
    enabled: active,
  });
  const leads = useQuery<{ meta?: { total?: number } }>({
    queryKey: ['marketing', 'leads', 'onboarding-count'],
    queryFn: () => marketingApi.get('/leads', { params: { limit: 1 } }).then((r) => r.data),
    enabled: active,
    staleTime: 60_000,
  });
  const team = useQuery<any[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: active,
    staleTime: 60_000,
  });

  const steps: ChecklistStep[] = [
    // The strategy is the brain that drives lead/content/channel/ad work, so it
    // leads the checklist.
    {
      id: 'strategy',
      to: '/onboarding/strategy',
      done: !!(strategy.data?.id || strategy.data?.archetype),
    },
    { id: 'agent', to: '/inbox?tab=agents', done: (agents.data?.length ?? 0) > 0 },
    { id: 'knowledge', to: '/inbox?tab=knowledge', done: (docs.data?.length ?? 0) > 0 },
    { id: 'brand', to: '/branding?tab=brain', done: brandProfile.data?.status === 'ACTIVE' },
    { id: 'channel', to: '/inbox?tab=channels', done: (channels.data?.length ?? 0) > 0 },
    { id: 'leads', to: '/leads', done: (leads.data?.meta?.total ?? 0) > 0 },
    // "Invite your team" — done once there's more than just the owner.
    { id: 'team', to: '/users', done: (team.data?.length ?? 0) > 1 },
    { id: 'site', to: '/sites', done: (sites.data?.length ?? 0) > 0 },
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
