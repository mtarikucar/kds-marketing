import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * "Is this string a PLACE whose clock we can ask?" — the one validation
 * `Workspace.timezone` has ever needed, and did not have.
 *
 * The column existed from the first migration with a `'UTC'` default and, until
 * now, exactly one writer anywhere in the codebase (`agency.service.ts`
 * createLocation). Every self-serve workspace therefore held the default, and
 * every consumer — the dashboard aggregates, the tasks list, sales targets, the
 * daily digest, and now the Growth Studio rail on the client — computed a
 * Turkish business's day boundaries on UTC. Fixing that means WRITING the
 * column, from signup and from a settings edit, which in turn means deciding
 * what is allowed in it. This is that decision, in one place, so the register
 * DTO and the workspace-settings DTO cannot drift apart on it.
 *
 * The authority is `Intl` itself: if `Intl.DateTimeFormat` accepts the zone,
 * every zoned computation we do (here, and in the browser's todayBounds twin)
 * will accept it too, which is the only property that actually matters. We
 * deliberately do NOT check membership of `Intl.supportedValuesOf('timeZone')`.
 * That list is the CANONICAL set and excludes the link names browsers and
 * operating systems still hand out in the wild — 'Asia/Calcutta', 'US/Eastern',
 * 'Europe/Kiev'. Rejecting a zone the operator's own browser just reported,
 * because a canonical alias exists for it, would turn a correct signup into a
 * 400 for no gain: `Intl` resolves the link perfectly well.
 *
 * The shape test in front of it exists for the other direction. `Intl` is
 * permitted (and in some engines happy) to accept fixed OFFSETS — '+03:00',
 * 'GMT+3', 'EST5EDT'. An offset is a fact about a MOMENT, not about a place: it
 * cannot answer "when does this workspace's Tuesday start" across a DST
 * transition, and stored in a column named `timezone` it silently freezes the
 * business at whatever offset happened to be in force the day it signed up.
 * Node 20 rejects '+03:00' on its own, so today this is belt-and-braces — but
 * the set of strings `Intl` tolerates has widened before, and the day it widens
 * again this is the thing standing between a widened parser and a workspace
 * pinned to a summer offset all winter.
 *
 * `'UTC'` is spelled out as an accepted single-segment value because it is the
 * schema default and a legitimate deliberate answer for a genuinely
 * UTC-operating business — see the migration note in the client's
 * `resolveZone`, which cannot tell those two cases apart and says so.
 */
const ZONE_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;

export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const zone = value.trim();
  // 64 is generous for a real zone ('America/Argentina/ComodRivadavia' is 31)
  // and keeps an unbounded string out of `Intl`'s parser.
  if (!zone || zone.length > 64) return false;
  if (!ZONE_SHAPE.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * class-validator binding for {@link isIanaTimeZone}, so a bad zone is a clean
 * 400 from the global ValidationPipe rather than a row that quietly breaks
 * every date-boundary read for the workspace that wrote it.
 */
export function IsIanaTimeZone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be an IANA time zone name (e.g. Europe/Istanbul)`,
        ...validationOptions,
      },
      validator: { validate: (value: unknown) => isIanaTimeZone(value) },
    });
  };
}
