import { overlapsBlackout, BlackoutWindow } from './blackout.util';

const win = (start: string, end: string, uid: string | null = null): BlackoutWindow => ({
  startAt: new Date(start),
  endAt: new Date(end),
  marketingUserId: uid,
});

const slot = (s: string, e: string): [number, number] => [
  new Date(s).getTime(),
  new Date(e).getTime(),
];

describe('overlapsBlackout', () => {
  it('a null-scoped window blocks any assignee', () => {
    const bo = [win('2027-06-14T09:00:00Z', '2027-06-14T12:00:00Z', null)];
    const [s, e] = slot('2027-06-14T10:00:00Z', '2027-06-14T10:30:00Z');
    expect(overlapsBlackout(bo, s, e, 'anyone')).toBe(true);
    expect(overlapsBlackout(bo, s, e, null)).toBe(true);
  });

  it('a member-scoped window blocks only that member', () => {
    const bo = [win('2027-06-14T09:00:00Z', '2027-06-14T12:00:00Z', 'u1')];
    const [s, e] = slot('2027-06-14T10:00:00Z', '2027-06-14T10:30:00Z');
    expect(overlapsBlackout(bo, s, e, 'u1')).toBe(true);
    expect(overlapsBlackout(bo, s, e, 'u2')).toBe(false);
    expect(overlapsBlackout(bo, s, e, null)).toBe(false);
  });

  it('does not block a slot outside the window', () => {
    const bo = [win('2027-06-14T09:00:00Z', '2027-06-14T10:00:00Z', null)];
    const [s, e] = slot('2027-06-14T10:00:00Z', '2027-06-14T10:30:00Z'); // starts at window end
    expect(overlapsBlackout(bo, s, e, 'anyone')).toBe(false);
  });
});
