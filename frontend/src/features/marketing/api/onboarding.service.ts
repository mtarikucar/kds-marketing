import marketingApi from './marketingApi';

export interface OnboardingState {
  dismissed: boolean;
  /**
   * Whether the MCP research lane has been PROVEN to work, by a real lease.
   *
   * The completion signal for the "connect your Claude" step, and deliberately
   * NOT "an API key exists". A key is intent: a workspace that made one and
   * never wrote the scheduled task looks, from every other angle, exactly like
   * a workspace whose lane works — and a half-finished setup is what this
   * feature dies of. The backend counts `research.mcp` agent runs, which only
   * a successful `claim_research_job` can create.
   */
  claudeLaneProven: boolean;
  /**
   * The workspace's MCP write mode, so the step can warn when it applies.
   *
   * Under `APPROVAL` the three Jeeta-keyed research data tools are not delayed,
   * they are unusable: the approval executor hands the result to the approving
   * human's HTTP response rather than back into the agent's turn, so the lane
   * silently falls back to plain web search and loses the Google Maps pain
   * signal it was designed around.
   */
  mcpWriteMode: 'APPROVAL' | 'AUTONOMOUS';
}

/** Shared query key so the dashboard, the checklist and the header agree. */
export const ONBOARDING_QUERY_KEY = ['marketing', 'onboarding'] as const;

export async function getOnboarding(): Promise<OnboardingState> {
  const { data } = await marketingApi.get<OnboardingState>('/onboarding');
  return data;
}

/**
 * Flip the dismissal flag.
 *
 * Returns ONLY that flag — the other two fields are workspace facts this write
 * does not touch, and the server does not re-read them. Callers caching the
 * full state must MERGE this in, never replace with it.
 */
export async function setOnboardingDismissed(
  dismissed: boolean,
): Promise<Pick<OnboardingState, 'dismissed'>> {
  const { data } = await marketingApi.patch<Pick<OnboardingState, 'dismissed'>>('/onboarding', {
    dismissed,
  });
  return data;
}
