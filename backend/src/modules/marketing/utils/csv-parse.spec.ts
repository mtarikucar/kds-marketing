import { parseCsv } from './csv-parse';

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const { headers, rows } = parseCsv('name,email\nAda,ada@x.com\nBob,bob@y.com');
    expect(headers).toEqual(['name', 'email']);
    expect(rows).toEqual([
      { name: 'Ada', email: 'ada@x.com' },
      { name: 'Bob', email: 'bob@y.com' },
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    const { rows } = parseCsv('name,note\n"Doe, John","says hi"');
    expect(rows[0]).toEqual({ name: 'Doe, John', note: 'says hi' });
  });

  it('handles escaped double quotes', () => {
    const { rows } = parseCsv('a\n"He said ""hi"""');
    expect(rows[0]).toEqual({ a: 'He said "hi"' });
  });

  it('handles quoted newlines and CRLF', () => {
    const { headers, rows } = parseCsv('a,b\r\n"line1\nline2",x\r\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([{ a: 'line1\nline2', b: 'x' }]);
  });

  it('trims header names and ignores trailing blank lines', () => {
    const { headers, rows } = parseCsv(' name , city \nAda,Istanbul\n\n');
    expect(headers).toEqual(['name', 'city']);
    expect(rows).toEqual([{ name: 'Ada', city: 'Istanbul' }]);
  });

  it('pads short rows with empty strings', () => {
    const { rows } = parseCsv('a,b,c\n1,2');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('returns empty for blank input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});
