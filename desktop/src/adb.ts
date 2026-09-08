import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { distillUiDump, findElement, UiScreen } from './ui-dump';

const run = promisify(execFile);

/** adb is slow when a phone is asleep and hangs forever when the cable is
 *  half-out. A bounded wait turns "the app froze" into "the phone did not
 *  answer", which is a thing a person can act on. */
const ADB_TIMEOUT_MS = Number(process.env.JEETA_ADB_TIMEOUT_MS ?? 20_000);

export interface DeviceInfo {
  serial: string;
  model?: string;
  androidVersion?: string;
  screen?: string;
}

export class AdbError extends Error {}

/**
 * Every adb call goes through here, and the arguments are always an ARRAY.
 *
 * Never a shell string. The command carries a URL a stranger's business put on
 * their website and text an LLM wrote; concatenating either into a shell line
 * is how `; rm -rf` gets a turn. `execFile` passes argv straight to the binary,
 * so a quote in a message is a quote in a message.
 */
async function adb(args: string[], serial?: string): Promise<string> {
  const argv = serial ? ['-s', serial, ...args] : args;
  try {
    const { stdout } = await run('adb', argv, { timeout: ADB_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e: unknown) {
    const err = e as { code?: string; killed?: boolean; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new AdbError(
        'adb bulunamadı. Android Platform Tools kurup PATH’e ekleyin, sonra tekrar deneyin.',
      );
    }
    if (err.killed) throw new AdbError('Telefon yanıt vermedi. Ekranı açıp kabloyu kontrol edin.');
    throw new AdbError((err.stderr || err.message || 'adb hatası').trim());
  }
}

/** Phones that are actually usable right now.
 *
 *  `unauthorized` is filtered out on purpose and reported separately: it means
 *  the USB-debugging prompt is waiting on the phone's screen, which is a thing
 *  the person can fix in three seconds — but only if they are told that,
 *  rather than shown an empty list. */
export async function listDevices(): Promise<{ ready: string[]; unauthorized: string[] }> {
  const out = await adb(['devices']);
  const ready: string[] = [];
  const unauthorized: string[] = [];
  for (const line of out.split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!serial) continue;
    if (state === 'device') ready.push(serial);
    else if (state === 'unauthorized') unauthorized.push(serial);
  }
  return { ready, unauthorized };
}

export async function describeDevice(serial: string): Promise<DeviceInfo> {
  const [model, version, size] = await Promise.all([
    adb(['shell', 'getprop', 'ro.product.model'], serial).catch(() => ''),
    adb(['shell', 'getprop', 'ro.build.version.release'], serial).catch(() => ''),
    adb(['shell', 'wm', 'size'], serial).catch(() => ''),
  ]);
  return {
    serial,
    model: model.trim() || undefined,
    androidVersion: version.trim() || undefined,
    screen: /(\d+x\d+)/.exec(size)?.[1],
  };
}

const KEYCODES: Record<string, string> = {
  BACK: '4',
  HOME: '3',
  ENTER: '66',
  TAB: '61',
  DEL: '67',
  APP_SWITCH: '187',
};

export interface ExecOutcome {
  result?: Record<string, unknown>;
  screenshot?: Buffer;
}

/**
 * Run one validated command.
 *
 * The server validated the shape before it was queued; this validates again
 * where it matters — the kind switch is exhaustive and an unknown kind throws
 * rather than falling through to a default that runs something. A bridge that
 * is one version behind the server must refuse a command it does not
 * understand, not improvise one.
 */
/**
 * What is on screen right now, distilled.
 *
 * Shared by `UI_DUMP` (look) and `TAP_ON` (look-and-press) so the two can
 * never disagree about what the screen contains — a second implementation
 * here would be a second set of filter rules to drift apart.
 */
async function readScreen(serial?: string): Promise<UiScreen> {
  // TWO attempts, because the common failure is transient and the way it fails
  // is worse than failing. `uiautomator dump` refuses while the screen is
  // moving — a list still settling, a keyboard sliding up, a page transition —
  // and it does so by printing "ERROR: could not get idle state." and exiting
  // ZERO. Taken at face value the next `cat` then yields nothing, the distiller
  // yields no elements, and the caller is told the screen is empty.
  //
  // That is the worst possible answer: a model reads "nothing here" about a
  // screen that is full, and TAP_ON reports "no such element — visible: (none)"
  // about a button that is right there. An error is recoverable; a confident
  // wrong answer is not.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await adb(['shell', 'uiautomator', 'dump', '/sdcard/jeeta-ui.xml'], serial);
    if (!/could not get idle state|ERROR/i.test(out)) {
      const xml = await adb(['shell', 'cat', '/sdcard/jeeta-ui.xml'], serial).catch(() => '');
      await adb(['shell', 'rm', '-f', '/sdcard/jeeta-ui.xml'], serial).catch(() => undefined);
      // An absent or stub file is the same failure wearing a different mask:
      // the dump claimed success and wrote nothing usable.
      if (xml.includes('<node')) return distillUiDump(xml);
    }
    // Screens settle. Half a second is the difference between "it never works
    // while anything animates" and "it works".
    if (attempt === 1) await new Promise((r) => setTimeout(r, 700));
  }
  throw new AdbError(
    'ekran okunamadı — telefonda bir şey hareket ediyor olabilir (liste, klavye, geçiş). Bir saniye sonra tekrar deneyin.',
  );
}

export async function execute(
  serial: string,
  kind: string,
  args: Record<string, unknown>,
): Promise<ExecOutcome> {
  switch (kind) {
    case 'TAP':
      await adb(['shell', 'input', 'tap', String(args.x), String(args.y)], serial);
      return {};

    case 'SWIPE':
      await adb(
        ['shell', 'input', 'swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2), String(args.durationMs)],
        serial,
      );
      return {};

    case 'TEXT':
      // `input text` cannot type a newline or a space reliably across OEM
      // keyboards, and it mangles unicode. The clipboard is the honest route
      // for anything a person wrote — but broadcasting to a clipboard helper
      // needs an app installed, so this stays the simple path and the server
      // caps the length. Spaces are escaped because `input text` splits on them.
      await adb(['shell', 'input', 'text', String(args.value).replace(/ /g, '%s')], serial);
      return {};

    case 'KEY': {
      const code = KEYCODES[String(args.key)];
      if (!code) throw new AdbError(`bu köprü "${args.key}" tuşunu bilmiyor`);
      await adb(['shell', 'input', 'keyevent', code], serial);
      return {};
    }

    case 'OPEN_URL':
      // The deep link. This is the one that matters: it hands an app a draft
      // through its own front door instead of driving its UI.
      await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', String(args.url)], serial);
      return {};

    case 'LAUNCH_APP':
      await adb(['shell', 'monkey', '-p', String(args.package), '-c', 'android.intent.category.LAUNCHER', '1'], serial);
      return {};

    case 'SCREENSHOT': {
      const dir = await mkdtemp(join(tmpdir(), 'jeeta-shot-'));
      const local = join(dir, 'screen.png');
      try {
        await adb(['exec-out', 'screencap', '-p'], serial).then(() => undefined);
        // exec-out returns binary on stdout; execFile gave us a string, so pull
        // the file instead — correctness over one fewer round trip.
        await adb(['shell', 'screencap', '-p', '/sdcard/jeeta-screen.png'], serial);
        await adb(['pull', '/sdcard/jeeta-screen.png', local], serial);
        await adb(['shell', 'rm', '-f', '/sdcard/jeeta-screen.png'], serial);
        return { screenshot: await readFile(local) };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    case 'UI_DUMP':
      // The DISTILLED screen, not the XML. The raw dump is a few hundred
      // kilobytes of layout scaffolding; what comes back here is the list of
      // things a person could press, each with the point that presses it.
      return { result: (await readScreen(serial)) as unknown as Record<string, unknown> };

    case 'TAP_ON': {
      // Read and tap in ONE command, on purpose: a caller that dumps, thinks,
      // and then taps a remembered coordinate is racing the phone. Here the
      // element is located and pressed microseconds apart.
      const screen = await readScreen(serial);
      const hit = findElement(screen, args as never);
      if (!hit) {
        // Naming what IS on screen turns "it didn't work" into a next step.
        const visible = screen.elements
          .slice(0, 12)
          .map((e) => e.text || e.desc || e.id)
          .filter(Boolean)
          .join(', ');
        throw new AdbError(
          `ekranda böyle bir öğe yok — görünenler: ${visible || '(etiketli öğe yok)'}`,
        );
      }
      await adb(['shell', 'input', 'tap', String(hit.tap[0]), String(hit.tap[1])], serial);
      return { result: { tapped: hit } };
    }

    default:
      throw new AdbError(
        `bu köprü "${kind}" komutunu bilmiyor — Jeeta Masaüstü'nü güncelleyin`,
      );
  }
}
