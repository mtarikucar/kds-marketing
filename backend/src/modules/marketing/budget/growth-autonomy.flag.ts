/**
 * Growth Autopilot autonomy feature flag (spec D7). The AUTONOMOUS lane —
 * propose → auto-apply with no human approval — is armed globally by env and
 * per-budget by `GrowthBudget.autonomyLevel === 'AUTONOMOUS'`. With the env
 * flag unset every autonomous branch is inert and behavior is identical to
 * the pre-autopilot ASSISTED flow, so the feature ships dark.
 */
export function growthAutopilotAutonomyEnabled(): boolean {
  const v = (process.env.GROWTH_AUTOPILOT_AUTONOMY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export type AutonomyLevel = 'SHADOW' | 'ASSISTED' | 'AUTONOMOUS';

export const AUTONOMY_LEVELS: AutonomyLevel[] = ['SHADOW', 'ASSISTED', 'AUTONOMOUS'];
