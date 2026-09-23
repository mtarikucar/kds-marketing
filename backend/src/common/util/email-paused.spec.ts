import { emailPaused } from './email-paused';

/**
 * One reader for a switch that stops a tenant's mail. Every "not paused"
 * answer here is a tenant who keeps sending, so the shapes a JSON column can
 * actually hold are pinned rather than assumed.
 */
describe('emailPaused', () => {
  it('is true only for an explicit paused:true', () => {
    expect(emailPaused({ email: { paused: true } })).toBe(true);
  });

  it('treats an absent key as "not paused", for every existing row', () => {
    expect(emailPaused(null)).toBe(false);
    expect(emailPaused(undefined)).toBe(false);
    expect(emailPaused({})).toBe(false);
    expect(emailPaused({ email: {} })).toBe(false);
    expect(emailPaused({ email: { paused: false } })).toBe(false);
  });

  it('never throws on a settings column holding something odd', () => {
    expect(emailPaused('paused')).toBe(false);
    expect(emailPaused(7)).toBe(false);
    expect(emailPaused({ email: 'off' })).toBe(false);
    expect(emailPaused({ email: null })).toBe(false);
    // Truthy, but not `true`: a string must not pause a tenant by accident.
    expect(emailPaused({ email: { paused: 'true' } })).toBe(false);
    expect(emailPaused({ email: { paused: 1 } })).toBe(false);
  });
});
