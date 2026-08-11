import marketingApi from './marketingApi';

export interface OnboardingState {
  dismissed: boolean;
}

/** Shared query key so the dashboard, the checklist and the header agree. */
export const ONBOARDING_QUERY_KEY = ['marketing', 'onboarding'] as const;

export async function getOnboarding(): Promise<OnboardingState> {
  const { data } = await marketingApi.get<OnboardingState>('/onboarding');
  return data;
}

export async function setOnboardingDismissed(dismissed: boolean): Promise<OnboardingState> {
  const { data } = await marketingApi.patch<OnboardingState>('/onboarding', { dismissed });
  return data;
}
