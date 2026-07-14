import { describe, it, expect } from 'vitest';
import { parseCsvRows, buildSampleRows } from './csv-preview';

describe('parseCsvRows — quote-aware CSV parsing (mapping-step preview)', () => {
  it('splits a plain CSV into rows of cells', () => {
    expect(parseCsvRows('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps a comma that is inside a quoted field (the naive-split bug)', () => {
    // Name,Address,Email  /  Acme,"123 Main St, Suite 5",acme@x.com
    expect(parseCsvRows('Name,Address,Email\nAcme,"123 Main St, Suite 5",acme@x.com')).toEqual([
      ['Name', 'Address', 'Email'],
      ['Acme', '123 Main St, Suite 5', 'acme@x.com'],
    ]);
  });

  it('handles an escaped "" quote inside a quoted field', () => {
    expect(parseCsvRows('a\n"he said ""hi"""')).toEqual([['a'], ['he said "hi"']]);
  });

  it('handles a newline inside a quoted field', () => {
    expect(parseCsvRows('note\n"line1\nline2"')).toEqual([['note'], ['line1\nline2']]);
  });

  it('tolerates \\r\\n line endings and a trailing newline', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns [] for empty content', () => {
    expect(parseCsvRows('')).toEqual([]);
  });
});

describe('buildSampleRows — keyed by backend headers, aligned by column', () => {
  it('aligns sample values under the correct header despite a quoted comma', () => {
    const content = 'Name,Address,Email\nAcme,"123 Main St, Suite 5",acme@x.com';
    const rows = buildSampleRows(content, ['Name', 'Address', 'Email']);
    expect(rows).toEqual([
      { Name: 'Acme', Address: '123 Main St, Suite 5', Email: 'acme@x.com' },
    ]);
  });

  it('caps at the first N data rows and fills missing columns with ""', () => {
    const content = 'a,b\n1,2\n3\n5,6\n7,8';
    const rows = buildSampleRows(content, ['a', 'b'], 3);
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '' },
      { a: '5', b: '6' },
    ]);
  });
});
