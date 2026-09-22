import {
  SEND_WINDOW_JITTER_MS,
  clampToSendWindow,
  normalizeSendWindow,
  parseSendWindow,
} from './mail-window';

/**
 * The send window is the one gate that DEFERS instead of refusing, so the two
 * things these pin are: it never fires early, and it never silently swallows a
 * mail. Everything else here is timezone arithmetic, which is where this
 * codebase has a documented bug class — a boundary computed from server-local
 * time. Prod runs UTC, the customers run UTC+3, and a naive fixed-offset clamp
 * lands an hour out twice a year in every DST zone.
 */

/** 2026-03-08 is the US spring-forward Sunday: 02:00 EST becomes 03:00 EDT. */
const NY_BEFORE_DST = new Date('2026-03-08T06:00:00Z'); // 01:00 EST, local Mar 8
const IST = 'Europe/Istanbul';

describe('parseSendWindow — settings.email.sendWindow', () => {
  it('reads nothing out of an empty or absent settings blob (today behaviour)', () => {
    expect(parseSendWindow(null, IST)).toBeNull();
    expect(parseSendWindow(undefined, IST)).toBeNull();
    expect(parseSendWindow({}, IST)).toBeNull();
    expect(parseSendWindow({ email: {} }, IST)).toBeNull();
    expect(parseSendWindow('not an object', IST)).toBeNull();
  });

  it('reads a configured window', () => {
    const w = parseSendWindow({ email: { sendWindow: { tz: IST, from: 9, to: 21 } } });
    expect(w).toEqual({ tz: IST, from: 9, to: 21 });
  });

  it('honours an explicit enabled:false without deleting the hours', () => {
    expect(
      parseSendWindow({ email: { sendWindow: { enabled: false, tz: IST, from: 9, to: 21 } } }),
    ).toBeNull();
  });

  it('falls back to the workspace timezone when the window names none', () => {
    expect(parseSendWindow({ email: { sendWindow: { from: 9, to: 21 } } }, IST)).toEqual({
      tz: IST,
      from: 9,
      to: 21,
    });
  });

  it('refuses a window with no timezone anywhere rather than guessing UTC', () => {
    // Guessing would send at 09:00 UTC = 12:00 for an Istanbul customer, which
    // is a worse outcome than not clamping at all.
    expect(parseSendWindow({ email: { sendWindow: { from: 9, to: 21 } } }, null)).toBeNull();
  });

  it('rejects hours that cannot describe a window', () => {
    const bad = [
      { from: 9, to: 9 }, // always, or never — unknowable
      { from: -1, to: 21 },
      { from: 9, to: 25 },
      { from: 9.5, to: 21 },
      { from: '9', to: '21' },
      { from: 9 },
      {},
    ];
    for (const sendWindow of bad) {
      expect(parseSendWindow({ email: { sendWindow: { tz: IST, ...sendWindow } } })).toBeNull();
    }
  });
});

describe('normalizeSendWindow — the per-workflow window from the DSL', () => {
  it('takes the same shape the DSL validates', () => {
    expect(normalizeSendWindow({ tz: IST, from: 10, to: 18 }, 'UTC')).toEqual({
      tz: IST,
      from: 10,
      to: 18,
    });
  });

  it('answers null for anything it cannot honour', () => {
    expect(normalizeSendWindow(undefined, IST)).toBeNull();
    expect(normalizeSendWindow({ from: 0, to: 0 }, IST)).toBeNull();
  });
});

describe('clampToSendWindow — when may this go out', () => {
  const window = { tz: IST, from: 9, to: 21 };

  it('never clamps when there is no window (every existing tenant)', () => {
    expect(clampToSendWindow(null, new Date('2026-03-08T00:30:00Z'))).toBeNull();
  });

  it('answers null inside the window — nothing is deferred that is already due', () => {
    // 12:00 Istanbul.
    expect(clampToSendWindow(window, new Date('2026-03-08T09:00:00Z'))).toBeNull();
  });

  it('treats the closing hour as exclusive', () => {
    // 20:59 local is still inside; 21:00 local is not.
    expect(clampToSendWindow(window, new Date('2026-03-08T17:59:00Z'))).toBeNull();
    expect(clampToSendWindow(window, new Date('2026-03-08T18:00:00Z'))).not.toBeNull();
  });

  it('moves a 02:30 send forward to this morning, not into tomorrow', () => {
    // 02:30 Istanbul = 23:30Z the day before.
    const at = new Date('2026-03-07T23:30:00Z');
    expect(clampToSendWindow(window, at)).toEqual(new Date('2026-03-08T06:00:00Z'));
  });

  it('moves a 23:30 send to the next local morning', () => {
    const at = new Date('2026-03-08T20:30:00Z'); // 23:30 Istanbul
    expect(clampToSendWindow(window, at)).toEqual(new Date('2026-03-09T06:00:00Z'));
  });

  it('always answers an instant strictly after the one it was given', () => {
    for (const hourZ of [0, 3, 6, 9, 12, 15, 18, 21, 23]) {
      const at = new Date(Date.UTC(2026, 2, 8, hourZ, 17, 0));
      const next = clampToSendWindow(window, at);
      if (next) expect(next.getTime()).toBeGreaterThan(at.getTime());
    }
  });

  describe('a window that wraps midnight (from > to)', () => {
    const night = { tz: IST, from: 22, to: 6 };

    it('is inside at 23:00 and at 02:00', () => {
      expect(clampToSendWindow(night, new Date('2026-03-08T20:00:00Z'))).toBeNull(); // 23:00
      expect(clampToSendWindow(night, new Date('2026-03-08T23:00:00Z'))).toBeNull(); // 02:00
    });

    it('defers a 07:00 send to the same evening', () => {
      const at = new Date('2026-03-08T04:00:00Z'); // 07:00 Istanbul
      expect(clampToSendWindow(night, at)).toEqual(new Date('2026-03-08T19:00:00Z'));
    });
  });

  describe('DST', () => {
    const ny = { tz: 'America/New_York', from: 9, to: 21 };

    it('lands on 09:00 local across a spring-forward, not an hour late', () => {
      // 01:00 EST (UTC-5) on the morning the clocks jump. 09:00 that same local
      // day is EDT (UTC-4) = 13:00Z. A fixed-offset clamp would say 14:00Z.
      expect(clampToSendWindow(ny, NY_BEFORE_DST)).toEqual(new Date('2026-03-08T13:00:00Z'));
    });

    it('lands on 09:00 local across a fall-back too', () => {
      // 2026-11-01: 02:00 EDT becomes 01:00 EST. 05:00Z is 01:00 EDT, local
      // Nov 1; 09:00 local that day is EST (UTC-5) = 14:00Z.
      expect(clampToSendWindow(ny, new Date('2026-11-01T05:00:00Z'))).toEqual(
        new Date('2026-11-01T14:00:00Z'),
      );
    });

    it('is stable in a zone that has no DST at all (Europe/Istanbul, UTC+3)', () => {
      const winter = clampToSendWindow(window, new Date('2026-01-15T00:30:00Z'));
      const summer = clampToSendWindow(window, new Date('2026-07-15T00:30:00Z'));
      expect(winter).toEqual(new Date('2026-01-15T06:00:00Z'));
      expect(summer).toEqual(new Date('2026-07-15T06:00:00Z'));
    });
  });

  it('never defers on an unknown timezone', () => {
    // A typo in a settings blob must not park a tenant's automation forever.
    expect(clampToSendWindow({ tz: 'Mars/Olympus', from: 9, to: 21 }, NY_BEFORE_DST)).toBeNull();
  });

  describe('jitter', () => {
    const at = new Date('2026-03-07T23:30:00Z'); // 02:30 Istanbul
    const open = new Date('2026-03-08T06:00:00Z').getTime();

    it('is zero without a seed, so an unseeded caller stays predictable', () => {
      expect(clampToSendWindow(window, at)).toEqual(new Date(open));
    });

    it('is the same answer for the same seed (a retried job does not walk)', () => {
      const a = clampToSendWindow(window, at, { seed: 'wf:run-1:2:lead-9' });
      const b = clampToSendWindow(window, at, { seed: 'wf:run-1:2:lead-9' });
      expect(a).toEqual(b);
    });

    it('spreads different seeds across the first half hour of the window', () => {
      const seeds = Array.from({ length: 40 }, (_, i) => `job-${i}`);
      const offsets = seeds.map(
        (seed) => clampToSendWindow(window, at, { seed })!.getTime() - open,
      );
      for (const o of offsets) {
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(SEND_WINDOW_JITTER_MS);
      }
      // A night's worth of deferred mail firing at 09:00:00 together is what
      // trips the shared relay's rate cap; the spread is the point.
      expect(new Set(offsets).size).toBeGreaterThan(20);
    });

    it('never spills past the end of a short window', () => {
      const short = { tz: IST, from: 9, to: 10 };
      const offsets = Array.from({ length: 20 }, (_, i) =>
        clampToSendWindow(short, at, { seed: `job-${i}` })!.getTime() - open,
      );
      for (const o of offsets) expect(o).toBeLessThanOrEqual(30 * 60_000);
    });
  });
});
