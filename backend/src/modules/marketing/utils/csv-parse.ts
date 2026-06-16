/**
 * Epic A5 — minimal dependency-free RFC-4180 CSV parser.
 *
 * Handles quoted fields (embedded commas/newlines), escaped quotes (""),
 * and CRLF/LF line endings. Header names are trimmed; field values are not
 * (leading/trailing spaces can be meaningful). Returns row objects keyed by
 * header. Good enough for lead imports; not a streaming parser.
 */
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function parseRecords(text: string): string[][] {
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
    if (ch === ',') {
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
  const records = parseRecords(text).filter(
    (r) => !(r.length === 1 && r[0].trim() === ''),
  );
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((rec) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = rec[idx] ?? '';
    });
    return obj;
  });
  return { headers, rows };
}
