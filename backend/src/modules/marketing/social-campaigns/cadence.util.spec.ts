import { nextCadenceSlot, Cadence } from './cadence.util';

const cadence = (over: Partial<Cadence> = {}): Cadence => ({
  daysOfWeek: [1, 3, 5], timeOfDay: '09:00', timezone: 'UTC', ...over,
});

describe('nextCadenceSlot', () => {
  it('returns the next configured weekday at timeOfDay, strictly after `from`', () => {
    const from = new Date('2026-07-06T10:00:00Z'); // a Monday, after 09:00
    const slot = nextCadenceSlot(cadence(), from)!;
    expect(slot).not.toBeNull();
    expect([1, 3, 5]).toContain(slot.getUTCDay());
    expect(slot.getUTCHours()).toBe(9);
    expect(slot.getUTCMinutes()).toBe(0);
    expect(slot.getTime()).toBeGreaterThan(from.getTime());
  });

  it('uses the same day when `from` is before timeOfDay on a configured day', () => {
    const from = new Date('2026-07-06T08:00:00Z'); // Monday 08:00, day is configured
    const slot = nextCadenceSlot(cadence(), from)!;
    expect(slot.getUTCDate()).toBe(6);
    expect(slot.getUTCHours()).toBe(9);
  });

  it('returns null when no weekday is configured', () => {
    expect(nextCadenceSlot(cadence({ daysOfWeek: [] }), new Date())).toBeNull();
  });
});
