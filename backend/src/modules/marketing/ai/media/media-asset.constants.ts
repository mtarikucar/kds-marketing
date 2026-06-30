export const GENERATED_ASSET_TYPES = ['IMAGE', 'VIDEO'] as const;
export type GeneratedAssetType = (typeof GENERATED_ASSET_TYPES)[number];

export const GENERATED_ASSET_STATUSES = [
  'QUEUED', 'GENERATING', 'READY', 'FAILED', 'BLOCKED',
] as const;
export type GeneratedAssetStatus = (typeof GENERATED_ASSET_STATUSES)[number];

export const TERMINAL_ASSET_STATUSES: ReadonlySet<GeneratedAssetStatus> = new Set([
  'READY', 'FAILED', 'BLOCKED',
]);

export function isTerminalAssetStatus(s: string): boolean {
  return TERMINAL_ASSET_STATUSES.has(s as GeneratedAssetStatus);
}
