import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';

/** A normalized NetGSM Netsantral CDR (call detail) record. */
export interface CdrRecord {
  uniqueid?: string;
  date?: string;
  source?: string;
  destination?: string;
  duration: number; // seconds (0 = not answered)
  direction?: string;
  recording?: string;
}

/**
 * NetGSM Netsantral CDR client — `gorusmeDetay` over the standard NetGSM API.
 *
 * POST https://api.netgsm.com.tr/netsantral/report  (JSON: usercode, password,
 * startdate, stopdate in ddMMyyyyHHmm) → call records (date, source, destination,
 * duration, direction, recording). NOTE: this endpoint is IP-ALLOW-LISTED to the
 * prod server, so it only authenticates from production (a local call returns a
 * pre-auth error code regardless of password). The exact response field casing is
 * provider-defined; `normalizeRecords` reads several known aliases defensively,
 * and `fetchRaw` exposes the raw body for the diagnostic endpoint to confirm it.
 */
@Injectable()
export class NetgsmCdrClient {
  private readonly logger = new Logger(NetgsmCdrClient.name);
  static readonly URL = 'https://api.netgsm.com.tr/netsantral/report';

  /** Raw NetGSM response (for the diagnostic endpoint — lets us see real fields). */
  async fetchRaw(
    creds: { usercode: string; password: string },
    startdate: string,
    stopdate: string,
  ): Promise<{ httpStatus: number; body: any }> {
    const res = await safeFetch(NetgsmCdrClient.URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usercode: creds.usercode, password: creds.password, startdate, stopdate }),
      timeoutMs: 20_000,
    });
    const body = await res.json().catch(() => null);
    return { httpStatus: res.status, body };
  }

  /** Normalized records; [] on an error/empty response. */
  async fetchCdr(
    creds: { usercode: string; password: string },
    startdate: string,
    stopdate: string,
  ): Promise<CdrRecord[]> {
    let body: any;
    try {
      ({ body } = await this.fetchRaw(creds, startdate, stopdate));
    } catch (e: any) {
      this.logger.warn(`netgsm CDR fetch failed: ${e?.message ?? e}`);
      return [];
    }
    if (!body) return [];
    // Error envelope: { code: "30"|"331"|..., error: "..." } (no records).
    if (!Array.isArray(body) && typeof body === 'object' && body.code && !body.values && !body.data) {
      this.logger.warn(`netgsm CDR error code=${body.code} ${body.error ?? ''}`);
      return [];
    }
    return normalizeRecords(body);
  }
}

const pick = (o: any, keys: string[]): any => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};

/** Map a provider record (any known shape/casing) into our CdrRecord. */
function toRecord(raw: any): CdrRecord {
  // Some shapes nest the fields under `values`.
  const o = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? raw.values : raw;
  const durRaw = pick(o, ['duration', 'billsec', 'sure', 'süre', 'talktime']);
  return {
    uniqueid: pick(raw, ['uniqueid', 'unique_id', 'id']) ?? pick(o, ['uniqueid', 'unique_id', 'id']),
    date: pick(o, ['date', 'tarih', 'datetime', 'calldate', 'start']),
    source: pick(o, ['source', 'caller', 'src', 'arayan', 'from']),
    destination: pick(o, ['destination', 'called', 'callee', 'dest', 'aranan', 'to']),
    duration: Number(durRaw ?? 0) || 0,
    direction: String(pick(o, ['direction', 'yon', 'yön', 'type']) ?? ''),
    recording: pick(o, ['recording', 'kayit', 'kayıt', 'record', 'recordingurl', 'voice']),
  };
}

/** Coerce the (array | keyed-object | {data:[]}) response into CdrRecord[]. */
export function normalizeRecords(body: any): CdrRecord[] {
  let items: any[] = [];
  if (Array.isArray(body)) items = body;
  else if (Array.isArray(body?.data)) items = body.data;
  else if (Array.isArray(body?.values)) items = body.values;
  else if (body && typeof body === 'object') {
    // keyed-by-uniqueid object → take the values that look like records
    items = Object.values(body).filter((v) => v && typeof v === 'object');
  }
  return items.map(toRecord).filter((r) => r.destination || r.uniqueid);
}
