import * as fs from 'fs';
import * as path from 'path';

/**
 * Every @Cron must carry a name.
 *
 * @nestjs/schedule keys an unnamed @Cron by a UUID it regenerates on every
 * boot. Such a job appears in the schedule listing as an opaque id that changes
 * with each deploy — unreadable, impossible to follow across restarts, and
 * indistinguishable from a job that has only just appeared.
 *
 * Found by reading `jeeta.list_scheduled_runs` against production twice and
 * noticing the UUID had changed between them. Exactly one cron in the codebase
 * was unnamed, and it happened to be the billing lifecycle sweep.
 *
 * A test rather than a comment, because the next unnamed @Cron would be just as
 * invisible and nobody would think to go looking for it.
 */
describe('scheduler hygiene', () => {
  const SRC = path.resolve(__dirname, '../..');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
    });

  it('names every @Cron, so the registry key is stable across restarts', () => {
    const unnamed: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/@Cron\(([^)]*)\)/gs)) {
        if (!m[1].includes('name:')) {
          const line = src.slice(0, m.index).split('\n').length;
          const rel = path.relative(SRC, file).split(path.sep).join('/');
          unnamed.push(`${rel}:${line}`);
        }
      }
    }
    expect(unnamed).toEqual([]);
  });
});
