import {
  GENERATED_ASSET_TYPES,
  GENERATED_ASSET_STATUSES,
  TERMINAL_ASSET_STATUSES,
  isTerminalAssetStatus,
} from './media-asset.constants';

describe('media-asset constants', () => {
  it('pins the asset type + status vocabularies', () => {
    expect([...GENERATED_ASSET_TYPES]).toEqual(['IMAGE', 'VIDEO']);
    expect([...GENERATED_ASSET_STATUSES]).toEqual([
      'QUEUED', 'GENERATING', 'READY', 'FAILED', 'BLOCKED',
    ]);
  });

  it('treats READY/FAILED/BLOCKED as terminal, QUEUED/GENERATING as not', () => {
    expect([...TERMINAL_ASSET_STATUSES].sort()).toEqual(['BLOCKED', 'FAILED', 'READY']);
    expect(isTerminalAssetStatus('READY')).toBe(true);
    expect(isTerminalAssetStatus('BLOCKED')).toBe(true);
    expect(isTerminalAssetStatus('GENERATING')).toBe(false);
    expect(isTerminalAssetStatus('QUEUED')).toBe(false);
  });
});
