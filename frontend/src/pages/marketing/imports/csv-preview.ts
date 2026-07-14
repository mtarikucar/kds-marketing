/**
 * Minimal RFC-4180 CSV parser for the mapping-step PREVIEW only. The real import
 * is parsed server-side (backend csv-parse.ts); this exists purely so the
 * "Sample values" shown next to each column line up with what the backend will
 * actually read. A naive split(',')/split('\n') shifts every column after a
 * quoted field that contains a comma or newline, so the preview would show the
 * wrong sample under each header. This mirrors the backend's quote handling:
 * double-quoted fields, embedded commas/newlines, and "" as an escaped quote.
 */
export function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++; // consume the second quote of an escaped ""
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      // A lone '\r' (or the '\r' of a '\r\n') is swallowed; '\n' closes the row.
      field += ch;
    }
  }
  // Flush a trailing row that had no closing newline (skip a truly empty tail).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Build the mapping-step sample rows: the first few DATA rows (after the header),
 * keyed by the BACKEND-parsed `headers` (so keys always align with the mapping
 * columns) with quote-aware values by column index.
 */
export function buildSampleRows(
  content: string,
  headers: string[],
  maxRows = 3,
): Record<string, string>[] {
  const rows = parseCsvRows(content);
  return rows.slice(1, 1 + maxRows).map((cells) =>
    Object.fromEntries(headers.map((h, idx) => [h, (cells[idx] ?? '').trim()])),
  );
}
