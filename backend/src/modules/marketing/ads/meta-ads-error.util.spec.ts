import { withPermissionHint } from './meta-ads-error.util';

describe('withPermissionHint', () => {
  it('appends actionable guidance to the opaque Meta permission error', () => {
    const meta =
      "Meta create campaign: Unsupported post request. Object with ID 'act_1028280256399167' does not exist, cannot be loaded due to missing permissions, or does not support this operation.";
    const out = withPermissionHint(meta);
    expect(out).toContain(meta);
    expect(out).toMatch(/ads_management/);
    expect(out).toMatch(/reconnect/i);
  });

  it('hints on a "Requires ads_management permission" error', () => {
    expect(withPermissionHint('(#200) Requires ads_management permission to manage the object')).toMatch(/reconnect/i);
  });

  it('leaves an unrelated error untouched', () => {
    const benign = 'Meta create campaign: Invalid parameter — objective is required';
    expect(withPermissionHint(benign)).toBe(benign);
  });

  it('returns empty string for empty/undefined input', () => {
    expect(withPermissionHint('')).toBe('');
    expect(withPermissionHint(undefined)).toBe('');
  });
});
