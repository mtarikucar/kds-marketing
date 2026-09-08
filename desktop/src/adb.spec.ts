/**
 * The device layer, with adb replaced by a script of canned answers.
 *
 * What is worth testing here is not "does adb work" — it does — but how this
 * code behaves when adb succeeds while telling us it failed. `uiautomator dump`
 * refuses to run while the screen is moving and reports that by printing an
 * error and exiting ZERO, which is the exact shape that turns "I could not read
 * the screen" into "the screen is empty".
 */
jest.mock('child_process', () => ({
  // Callback-style, resolving with an OBJECT: `promisify` has no special case
  // for a mock, so it resolves with the first callback value, and adb.ts
  // destructures `{ stdout }` off it.
  execFile: jest.fn(),
}));

import { execFile } from 'child_process';
import { execute, AdbError } from './adb';

type Reply = { stdout?: string; error?: Error };

/** Answer each adb invocation in turn, keyed by what the command was. */
function script(replies: (argv: string[]) => Reply): string[][] {
  const calls: string[][] = [];
  (execFile as unknown as jest.Mock).mockImplementation(
    (_cmd: string, argv: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
      calls.push(argv);
      const r = replies(argv);
      if (r.error) cb(r.error, null);
      else cb(null, { stdout: r.stdout ?? '', stderr: '' });
    },
  );
  return calls;
}

const GOOD_XML =
  '<hierarchy><node class="android.widget.Button" text="Gönder" clickable="true" bounds="[0,0][100,50]" /></hierarchy>';
const DUMPED = 'UI hierchary dumped to: /sdcard/jeeta-ui.xml';
const BUSY = 'ERROR: could not get idle state.';

beforeEach(() => (execFile as unknown as jest.Mock).mockReset());

describe('reading a screen that will not hold still', () => {
  it('retries once, because a moving screen settles', async () => {
    let dumps = 0;
    const calls = script((argv) => {
      if (argv.includes('dump')) return { stdout: ++dumps === 1 ? BUSY : DUMPED };
      if (argv.includes('cat')) return { stdout: GOOD_XML };
      return {};
    });

    const out = await execute('emulator-5554', 'UI_DUMP', {});
    expect((out.result as { elements: unknown[] }).elements).toHaveLength(1);
    expect(dumps).toBe(2);
    // The first failed dump must NOT have been followed by a read: catting a
    // file the dump did not write is how a stale screen gets reported as the
    // current one.
    expect(calls.filter((c) => c.includes('cat'))).toHaveLength(1);
  });

  it('says the screen would not hold still, rather than that it was empty', async () => {
    script((argv) => (argv.includes('dump') ? { stdout: BUSY } : { stdout: '' }));

    // The whole point. An empty element list is a claim about the phone; this
    // is a claim about us, and only one of them is true.
    await expect(execute('emulator-5554', 'UI_DUMP', {})).rejects.toThrow(AdbError);
    await expect(execute('emulator-5554', 'UI_DUMP', {})).rejects.toThrow(/hareket ediyor/i);
  });

  it('treats a dump that wrote nothing as a failure, not as a blank screen', async () => {
    // uiautomator reported success and the file is empty — the same lie in a
    // different costume.
    script((argv) => (argv.includes('dump') ? { stdout: DUMPED } : { stdout: '' }));
    await expect(execute('emulator-5554', 'UI_DUMP', {})).rejects.toThrow(/ekran okunamadı/i);
  });

  it('does not tap when it could not read the screen it was tapping on', async () => {
    // TAP_ON resolves against a fresh read. If the read failed, pressing
    // anything would be pressing a guess.
    const calls = script((argv) => (argv.includes('dump') ? { stdout: BUSY } : { stdout: '' }));
    await expect(
      execute('emulator-5554', 'TAP_ON', { text: 'Gönder', occurrence: 1 }),
    ).rejects.toThrow(AdbError);
    expect(calls.some((c) => c.includes('tap'))).toBe(false);
  });
});

describe('the argv contract', () => {
  it('never builds a shell string, whatever the command carries', async () => {
    const calls = script(() => ({ stdout: '' }));
    await execute('emulator-5554', 'OPEN_URL', {
      url: 'https://wa.me/905551112233?text=a%20b%3B%20rm%20-rf',
    });
    // Every argument arrives as its own array member — the URL is one item, not
    // a fragment of a line somebody's shell will re-split.
    const open = calls.find((c) => c.includes('am'))!;
    expect(open).toContain('https://wa.me/905551112233?text=a%20b%3B%20rm%20-rf');
    expect(open.some((a) => a.includes(' '))).toBe(false);
  });

  it('addresses the phone by serial on every call', async () => {
    const calls = script(() => ({ stdout: '' }));
    await execute('emulator-5554', 'KEY', { key: 'HOME' });
    // A workspace with two phones plugged into one laptop must never have a
    // command land on whichever adb picked.
    for (const c of calls) expect(c.slice(0, 2)).toEqual(['-s', 'emulator-5554']);
  });
});
