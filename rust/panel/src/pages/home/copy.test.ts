import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n/config';
import { actionCodes, useHomeCopy } from './copy';

/** Where the use cases write their ledger entries. */
const USE_CASES = resolve(__dirname, '../../../../crates/jt_app/src');
/** Files that list use-case names, which look like actions but are not written to the ledger. */
const NAME_TABLES = new Set(['catalog.rs', 'gate.rs']);
/** Actions the server names at run time (`inbox.<job name>`, `usecases/jobs.rs`). */
const ASSEMBLED = new Set(['inbox.response_sla', 'inbox.snooze_wake']);

function rustSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : rustSources(path);
    return entry.name.endsWith('.rs') && !NAME_TABLES.has(entry.name) ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('the home log’s wording of ledger actions', () => {
  it('words the same actions in both languages', () => {
    expect([...actionCodes.en].sort()).toEqual([...actionCodes.tr].sort());
  });

  // A guard against a name nobody writes (`strategy.approved` for `strategy.approve`), which
  // would leave the real action showing as a raw code. It proves the name exists, not its use.
  it('words only actions the server names', () => {
    const source = rustSources(USE_CASES).join('\n');
    const codes = [...new Set(actionCodes.tr.map(code => code.split(':')[0]))];
    expect(codes.filter(code => !ASSEMBLED.has(code) && !source.includes(`"${code}"`))).toEqual([]);
  });

  it('words a send result by how it ended', () => {
    const copy = renderHook(() => useHomeCopy()).result.current;
    const words = (state?: string) => copy.action('inbox.reply.result', state ? { state } : {});
    expect(new Set([words('sent'), words('failed'), words('refused'), words('unknown'), words()]).size).toBe(5);
    // A state without wording of its own, and an entry without a payload, read as the plain result.
    expect(words('sending')).toBe(words());
    expect(copy.action('inbox.reply.result')).toBe(words());
    expect(copy.action('strategy.approve')).not.toBeNull();
    expect(copy.action('no.such_action')).toBeNull();
  });
});
