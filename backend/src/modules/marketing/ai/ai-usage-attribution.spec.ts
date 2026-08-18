import * as fs from 'fs';
import * as path from 'path';

/**
 * Every LLM call must be attributable, or the cost accounting is a half-truth.
 *
 * `AnthropicService.recordUsage` only writes an AiUsageLog row when BOTH
 * `workspaceId` and `action` are supplied. They are optional on the options
 * type — deliberately, so no call site was forced to change when measurement
 * was introduced — with the result that 12 of 23 call sites never passed them.
 * Those calls still reserved credits, so customers were billed while nothing
 * recorded what the vendor actually charged us, which is exactly how a price
 * drifts away from its cost without anyone noticing.
 *
 * A type cannot express "optional, but always supplied in this repo", so this
 * walks the source instead.
 */
const ROOT = path.join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) out.push(p);
  }
  return out;
}

/** The options object of each `anthropic.complete(...)` call, brace-matched. */
function callOptionObjects(src: string): string[] {
  const out: string[] = [];
  const re = /anthropic\.complete\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe('AI usage attribution', () => {
  it('every anthropic.complete call passes workspaceId and action', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('anthropic.complete({')) continue;
      callOptionObjects(src).forEach((opts, i) => {
        const hasWs = /(^|[\s,{])workspaceId\s*[,:]/.test(opts);
        const hasAction = /(^|[\s,{])action\s*:/.test(opts);
        if (!hasWs || !hasAction) {
          offenders.push(
            `${path.relative(ROOT, file)} call#${i + 1}` +
              ` (workspaceId: ${hasWs ? 'ok' : 'MISSING'}, action: ${hasAction ? 'ok' : 'MISSING'})`,
          );
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
