/**
 * Epic A5 — minimal dependency-free RFC-4180 CSV parser.
 *
 * Handles quoted fields (embedded commas/newlines), escaped quotes (""),
 * and CRLF/LF line endings. The delimiter is SNIFFED from the header line
 * (comma / semicolon / tab) — Turkish-locale Excel exports "CSV" with a ';'
 * list separator, which used to parse as a single unusable column. Header
 * names are trimmed and DEDUPED (repeats get a " (2)" suffix) so a duplicate
 * column can't silently overwrite the earlier one's values. Field values are
 * not trimmed (leading/trailing spaces can be meaningful). Returns row
 * objects keyed by header. Good enough for lead imports; not a streaming parser.
 */
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Count delimiter candidates OUTSIDE quotes on the first line; most frequent
 *  wins (comma on a tie — the RFC default). Exported so the frontend preview
 *  parser can mirror the same choice. */
export function sniffDelimiter(text: string): ',' | ';' | '\t' {
  const counts: Record<',' | ';' | '\t', number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++; // escaped quote — stay in quotes
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '\n') break; // header line only
    if (ch === ',' || ch === ';' || ch === '\t') counts[ch]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/** Suffix repeated header names ("Phone", "Phone (2)", …) so each column keeps
 *  its own data and its own mapping row instead of the last silently winning. */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let started = false; // whether the current record has any content
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      record.push(field);
      field = '';
      started = true;
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      started = false;
      i++;
      continue;
    }
    field += ch;
    started = true;
    i++;
  }
  if (started || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export function parseCsv(text: string): ParsedCsv {
  const records = parseRecords(text, sniffDelimiter(text)).filter(
    (r) => !(r.length === 1 && r[0].trim() === ''),
  );
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = dedupeHeaders(records[0].map((h) => h.trim()));
  const rows = records.slice(1).map((rec) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = rec[idx] ?? '';
    });
    return obj;
  });
  return { headers, rows };
}
