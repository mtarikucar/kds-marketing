/**
 * Tolerant reader for a single NetGSM `/sms/report` row. The exact wire format
 * is account-dependent and must be confirmed against a captured live response
 * (see the integration design doc's "Open items"); until then this reads the
 * plausible JSON shapes and returns null for anything it cannot confidently
 * interpret. Null is always a SAFE no-op for the poller: it leaves the message
 * SENT and re-polls, rather than risking a wrong terminal status.
 */
export interface NetgsmReportRow {
  durumcode: string;
  hatakod: string | null;
}

function pick(row: any): NetgsmReportRow | null {
  if (!row || typeof row !== 'object') return null;
  const durumRaw = row.durumcode ?? row.durum ?? row.status ?? row.statusid;
  if (durumRaw == null || String(durumRaw).trim() === '') return null;
  const hataRaw = row.hatakod ?? row.hata ?? row.errorcode;
  return {
    durumcode: String(durumRaw).trim(),
    hatakod: hataRaw == null || String(hataRaw).trim() === '' ? null : String(hataRaw).trim(),
  };
}

export function parseNetgsmReport(body: unknown): NetgsmReportRow | null {
  let data: any = body;

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return null; // unknown text/XML format — lock from a live capture
    }
  }

  if (Array.isArray(data)) return data.length ? pick(data[0]) : null;
  if (data && typeof data === 'object') {
    const envelope = data.report ?? data.data ?? data.messages;
    if (Array.isArray(envelope)) return envelope.length ? pick(envelope[0]) : null;
    return pick(data);
  }
  return null;
}
