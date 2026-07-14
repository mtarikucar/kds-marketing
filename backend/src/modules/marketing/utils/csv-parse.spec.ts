import { parseCsv, sniffDelimiter } from './csv-parse';

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

  // Turkish-locale Excel exports "CSV" with a ';' list separator — the
  // comma-only parser read the whole file as ONE column, making every
  // Turkish Excel export unimportable.
  it('parses a semicolon-delimited CSV (Turkish Excel default)', () => {
    const { headers, rows } = parseCsv('name;email;city\nAda;ada@x.com;İzmir');
    expect(headers).toEqual(['name', 'email', 'city']);
    expect(rows).toEqual([{ name: 'Ada', email: 'ada@x.com', city: 'İzmir' }]);
  });

  it('parses a tab-delimited file and keeps quoted delimiters literal', () => {
    const { headers, rows } = parseCsv('a\tb\n"x\ty"\tz');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([{ a: 'x\ty', b: 'z' }]);
  });

  it('a comma inside quotes does not fool the semicolon sniffer', () => {
    const { headers, rows } = parseCsv('"Doe, John";note\n"Smith, Jane";hi');
    expect(headers).toEqual(['Doe, John', 'note']);
    expect(rows[0]).toEqual({ 'Doe, John': 'Smith, Jane', note: 'hi' });
  });

  // Duplicate header names silently collapsed: rows are keyed by header, so
  // the LAST duplicate column overwrote the earlier one's values and the
  // mapping UI showed two rows controlling the same entry.
  it('dedupes duplicate headers so each column keeps its own data', () => {
    const { headers, rows } = parseCsv('Phone,Phone,Name\n111,222,Ada');
    expect(headers).toEqual(['Phone', 'Phone (2)', 'Name']);
    expect(rows[0]).toEqual({ Phone: '111', 'Phone (2)': '222', Name: 'Ada' });
  });
});

describe('sniffDelimiter', () => {
  it('picks the most frequent candidate on the header line only', () => {
    expect(sniffDelimiter('a,b,c\nx;y;z')).toBe(',');
    expect(sniffDelimiter('a;b;c\nx,y,z')).toBe(';');
    expect(sniffDelimiter('a\tb\tc')).toBe('\t');
  });

  it('defaults to comma on a tie or when no delimiter is present', () => {
    expect(sniffDelimiter('justoneheader')).toBe(',');
    expect(sniffDelimiter('a,b;c')).toBe(','); // 1 comma vs 1 semicolon → comma
  });
});
