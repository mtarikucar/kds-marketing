/**
 * The send window — the only gate that DEFERS a mail instead of refusing it.
 *
 * Automation sends whenever its trigger fires, which is how a drip lands at
 * 02:30 and a follow-up wakes a customer up (`no-send-window`). A window says
 * "these local hours only"; everything outside it is queued forward with a
 * `retryAt`, never dropped — a marketing mail nobody read is a missed mail, but
 * a marketing mail nobody SENT is a broken automation.
 *
 * Pure on purpose: no Nest, no Prisma, no clock of its own. The guard passes
 * the instant in, which is what makes the DST cases below testable at all.
 *
 * ## Why the arithmetic is written out rather than borrowed
 *
 * `common/scheduling/workspace-local-day.ts` answers "which local hour/date is
 * it" and nothing more — it cannot build an instant AT a local hour, which is
 * the whole job here. The rule it carries still governs: one implementation,
 * one place to be wrong. Prod containers run UTC, the customers run UTC+3, and
 * a clamp that reads a fixed offset once is an hour out twice a year in every
 * DST zone.
 *
 * ## Behaviour-preserving by construction (PLAN G3)
 *
 * No window configured — which is every existing tenant — means every entry
 * point here answers `null`, and `null` means "send now". A window that cannot
 * be honoured (no timezone, a typo'd zone, hours that describe nothing) is the
 * same answer: not clamping is always safer than parking a tenant's automation
 * on a guess.
 */

/** A local-hour window, resolved against exactly one IANA zone. */
export interface SendWindow {
  /** IANA zone the hours below are read in. Never defaulted to UTC. */
  tz: string;
  /** Local hour the window opens, 0-23. */
  from: number;
  /** Local hour the window closes, EXCLUSIVE, 1-24. `from > to` wraps midnight. */
  to: number;
}

/**
 * How far into the window a deferred send may be nudged.
 *
 * A night's worth of deferred jobs all firing at 09:00:00 is a burst on one
 * shared relay (`smtpout.secureserver.net` is a single mailbox for the whole
 * platform), so the queue is smeared over the first half hour. Deterministic,
 * seeded by the caller's own key: a retried job must not walk forward each
 * time it is retried.
 */
export const SEND_WINDOW_JITTER_MS = 30 * 60_000;

export interface ClampOptions {
  /**
   * A stable key for this piece of work — a job dedupKey, `wf:<run>:<step>:<lead>`,
   * anything the caller can reproduce. Absent ⇒ no jitter at all, which keeps
   * an unseeded caller exactly predictable.
   */
  seed?: string;
}

/**
 * Read `settings.email.sendWindow` off a `Workspace.settings` jsonb blob.
 *
 * `fallbackTz` is the workspace's own timezone, for a window that only names
 * hours. With neither, there is no answer worth guessing (see below).
 */
export function parseSendWindow(settings: unknown, fallbackTz?: string | null): SendWindow | null {
  const email = pick(settings, 'email');
  return normalizeSendWindow(pick(email, 'sendWindow'), fallbackTz);
}

/**
 * Normalise one raw window object off an untrusted blob.
 *
 * `parseSendWindow` above is its only caller today: the workspace window is
 * the ONLY quiet-hours setting the product has. (The workflow DSL used to
 * validate a per-workflow window here too, but nothing ever read it, so the
 * field is gone rather than pretending — see `TriggerSchema`.) It stays a
 * separate function because the shape it accepts is a tenant's jsonb, and a
 * window that cannot be trusted has to be rejected in one place.
 */
export function normalizeSendWindow(raw: unknown, fallbackTz?: string | null): SendWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;

  // An explicit off switch keeps the hours on the row, so switching the window
  // back on does not mean retyping it.
  if (w.enabled === false) return null;

  const from = hour(w.from, 0, 23);
  const to = hour(w.to, 1, 24);
  if (from === null || to === null) return null;
  // Equal bounds describe either "always" or "never" and there is no way to
  // tell which was meant. Refuse to act on it.
  if (from === to) return null;

  const tz = typeof w.tz === 'string' && w.tz.trim() ? w.tz.trim() : (fallbackTz ?? '').trim();
  // Hours with no zone would be read as UTC — 09:00 UTC is midday for an
  // Istanbul customer, which is a worse outcome than not clamping at all.
  if (!tz) return null;

  return { tz, from, to };
}

/**
 * When may this mail go out?
 *
 * `null` means now — there is no window, the window cannot be honoured, or the
 * instant is already inside it. Otherwise: the next opening of the window,
 * always strictly later than `at`.
 */
export function clampToSendWindow(
  window: SendWindow | null,
  at: Date,
  opts: ClampOptions = {},
): Date | null {
  if (!window) return null;

  try {
    const local = localParts(window.tz, at);
    if (within(window, local.hour)) return null;

    // The next opening is always the next occurrence of local `from`:00 —
    // true for a wrapping window as much as a plain one, because being outside
    // the window is exactly what says the opening has not happened yet today.
    let open = instantAtLocalHour(window.tz, local, window.from);
    if (open.getTime() <= at.getTime()) {
      open = instantAtLocalHour(window.tz, nextLocalDay(local), window.from);
    }

    return new Date(open.getTime() + jitterMs(window, opts.seed));
  } catch {
    // An unknown or typo'd zone must never park a tenant's automation. Every
    // other failure mode here is the same class: if the clamp cannot be
    // computed, today's behaviour (send now) is the answer.
    return null;
  }
}

// ── internals ────────────────────────────────────────────────────────────────

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
}

function within(window: SendWindow, localHour: number): boolean {
  // `to` is exclusive: a 9-21 window is shut at 21:00 sharp.
  return window.from < window.to
    ? localHour >= window.from && localHour < window.to
    : localHour >= window.from || localHour < window.to;
}

function partsOf(tz: string, at: Date): LocalParts & { minute: number; second: number } {
  // Throws RangeError on an unknown zone, which is exactly the signal the
  // caller catches.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // 24 is a legal formatToParts output for midnight in some locales.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

function localParts(tz: string, at: Date): LocalParts {
  const p = partsOf(tz, at);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour };
}

function offsetMs(tz: string, at: Date): number {
  const p = partsOf(tz, at);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `at` may carry milliseconds the formatter never showed us.
  return wall - (at.getTime() - at.getMilliseconds());
}

/**
 * The instant at which `tz` reads `hour`:00 on that local date.
 *
 * Two passes: the first guess uses the offset in force at the UTC instant of
 * the same wall clock, which is the wrong side of a transition by up to an
 * hour; the second uses the offset in force at the guess, which is the one
 * that actually applies. That is the whole DST fix.
 */
function instantAtLocalHour(tz: string, day: LocalParts, hour: number): Date {
  const wall = Date.UTC(day.year, day.month - 1, day.day, hour, 0, 0);
  let guess = wall - offsetMs(tz, new Date(wall));
  guess = wall - offsetMs(tz, new Date(guess));
  return new Date(guess);
}

function nextLocalDay(day: LocalParts): LocalParts {
  // Date.UTC normalises the rollover (31 Jan + 1 = 1 Feb) for us.
  const d = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: day.hour,
  };
}

function jitterMs(window: SendWindow, seed?: string): number {
  if (!seed) return 0;
  const lengthMs = (((window.to - window.from + 24) % 24 || 24) * 3_600_000);
  // Never smear past the middle of a short window — a one-hour window must not
  // be spread over its own closing time.
  const cap = Math.min(SEND_WINDOW_JITTER_MS, Math.floor(lengthMs / 2));
  if (cap <= 0) return 0;
  return fnv1a(seed) % (cap + 1);
}

/** FNV-1a, 32-bit. Any stable hash would do; this one is four lines. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hour(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function pick(o: unknown, key: string): unknown {
  return o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
}
