// AUDIO joined IMAGE/VIDEO when the catalogue gained TTS, music and SFX models
// (ElevenLabs). No migration was needed: GeneratedAsset.type is a plain String
// column and params is free-form Json, so the vocabulary lives here alone.
// (fal-ai/mmaudio-v2 is the confusing one — an AUDIO *capability* whose output
// is a muxed mp4, so it is typed VIDEO.)
export const GENERATED_ASSET_TYPES = ['IMAGE', 'VIDEO', 'AUDIO'] as const;
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
