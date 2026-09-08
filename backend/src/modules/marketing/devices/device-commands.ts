import { BadRequestException } from '@nestjs/common';

/**
 * The instruction set a device understands.
 *
 * It is small on purpose, and the omission that matters most is SHELL. A
 * remote shell into somebody's personal phone is a different risk class from
 * "open this link": it can read messages, exfiltrate files and install
 * software, and once it is in the same queue as a tap the audit trail can no
 * longer tell the two apart either. Anything that needs more than this list
 * should have to argue for its own entry, in this file, where the argument is
 * visible.
 */
export const DEVICE_COMMAND_KINDS = [
  'TAP',
  'SWIPE',
  'TEXT',
  'KEY',
  'OPEN_URL',
  'LAUNCH_APP',
  'SCREENSHOT',
  'UI_DUMP',
] as const;
export type DeviceCommandKind = (typeof DEVICE_COMMAND_KINDS)[number];

export const DEVICE_COMMAND_STATUSES = [
  'QUEUED',
  'CLAIMED',
  'DONE',
  'FAILED',
  /** The person at the bridge said no. Not a failure — the feature working. */
  'REFUSED',
  'EXPIRED',
] as const;
export type DeviceCommandStatus = (typeof DEVICE_COMMAND_STATUSES)[number];

/** MANUAL = a human presses the button for every command. */
export const DEVICE_MODES = ['MANUAL', 'AUTO'] as const;
export const DEVICE_STATUSES = ['ACTIVE', 'PAUSED', 'REVOKED'] as const;

/**
 * Only schemes a phone should be asked to open.
 *
 * `https` covers every deep link worth having (wa.me, ig.me, a map, a form).
 * `tel` places a call. Everything else — `file`, `content`, `intent`, a custom
 * scheme belonging to an app we know nothing about — is refused, because an
 * intent URL can name a component and its extras, which is a way to reach
 * parts of an app its own UI would never offer.
 */
const ALLOWED_URL_SCHEMES = new Set(['https:', 'tel:']);

/** Android keycodes worth exposing. A number is not accepted: the point of a
 *  name list is that a typo cannot become a different button. */
export const ALLOWED_KEYS = ['BACK', 'HOME', 'ENTER', 'TAB', 'DEL', 'APP_SWITCH'] as const;

const MAX_TEXT_LENGTH = 4000;
const MAX_SWIPE_MS = 5000;

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new BadRequestException(`${key} must be a number`);
  }
  return v;
}

function coordinate(args: Record<string, unknown>, key: string): number {
  const v = num(args, key);
  // Negative or absurd coordinates are a caller bug, and a phone will happily
  // accept them and tap nothing — a silent no-op is the worst outcome for
  // something a person is watching.
  if (v < 0 || v > 20000) throw new BadRequestException(`${key} is outside the screen`);
  return Math.round(v);
}

function str(args: Record<string, unknown>, key: string, max: number): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestException(`${key} is required`);
  if (v.length > max) throw new BadRequestException(`${key} is longer than ${max} characters`);
  return v;
}

/**
 * Validate a command BEFORE it is written, not before it is executed.
 *
 * The bridge is on somebody's desk behind a cable; a command that turns out to
 * be malformed there fails minutes later, in a place nobody is looking, with
 * the caller long gone. Refusing at the queue keeps the error where the
 * mistake was made.
 *
 * Returns the NORMALISED args — the row stores what will actually run, so the
 * audit reads the command that happened rather than the one that was asked for.
 */
export function validateDeviceCommand(kind: string, raw: unknown): Record<string, unknown> {
  if (!(DEVICE_COMMAND_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException(
      `unknown device command "${kind}" — expected one of: ${DEVICE_COMMAND_KINDS.join(', ')}`,
    );
  }
  const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  switch (kind as DeviceCommandKind) {
    case 'TAP':
      return { x: coordinate(args, 'x'), y: coordinate(args, 'y') };

    case 'SWIPE': {
      const ms = args.durationMs === undefined ? 300 : num(args, 'durationMs');
      if (ms <= 0 || ms > MAX_SWIPE_MS) {
        throw new BadRequestException(`durationMs must be between 1 and ${MAX_SWIPE_MS}`);
      }
      return {
        x1: coordinate(args, 'x1'),
        y1: coordinate(args, 'y1'),
        x2: coordinate(args, 'x2'),
        y2: coordinate(args, 'y2'),
        durationMs: Math.round(ms),
      };
    }

    case 'TEXT':
      return { value: str(args, 'value', MAX_TEXT_LENGTH) };

    case 'KEY': {
      const key = str(args, 'key', 32).toUpperCase();
      if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
        throw new BadRequestException(`unknown key "${key}" — expected one of: ${ALLOWED_KEYS.join(', ')}`);
      }
      return { key };
    }

    case 'OPEN_URL': {
      const value = str(args, 'url', 4000);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new BadRequestException('url is not a valid URL');
      }
      if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
        throw new BadRequestException(
          `"${parsed.protocol}" links are not opened on a device — only ${[...ALLOWED_URL_SCHEMES].join(' and ')}`,
        );
      }
      return { url: parsed.toString() };
    }

    case 'LAUNCH_APP': {
      const pkg = str(args, 'package', 200);
      // An Android package name, not a shell fragment. The bridge interpolates
      // this into an adb argument, so anything that is not a package must not
      // get that far.
      if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(pkg)) {
        throw new BadRequestException(`"${pkg}" is not an Android package name`);
      }
      return { package: pkg };
    }

    case 'SCREENSHOT':
    case 'UI_DUMP':
      return {};
  }
}

/**
 * A one-line description of what a command will do, in the owner's language.
 *
 * The bridge shows this to the person whose thumb is about to approve it, and
 * a person cannot consent to `{"kind":"OPEN_URL","args":{...}}`. It is built
 * here rather than in the bridge so that what the server queued and what the
 * human was asked are the same sentence.
 */
export function describeDeviceCommand(kind: string, args: Record<string, unknown>): string {
  switch (kind as DeviceCommandKind) {
    case 'TAP':
      return `Ekrana dokun (${args.x}, ${args.y})`;
    case 'SWIPE':
      return `Ekranı kaydır (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})`;
    case 'TEXT':
      return `Yaz: "${String(args.value ?? '').slice(0, 120)}"`;
    case 'KEY':
      return `Tuş: ${args.key}`;
    case 'OPEN_URL':
      return `Aç: ${args.url}`;
    case 'LAUNCH_APP':
      return `Uygulamayı başlat: ${args.package}`;
    case 'SCREENSHOT':
      return 'Ekran görüntüsü al';
    case 'UI_DUMP':
      return 'Ekrandaki öğeleri oku';
    default:
      return String(kind);
  }
}
