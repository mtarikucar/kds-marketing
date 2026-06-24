/**
 * Tolerant parser for the Netsantral origination response. The exact wire shape
 * (JSON vs plain code) is an account/doc-dependent open item; we read JSON when
 * possible and fall back to a leading numeric status code, returning a structured
 * outcome. Any unreadable body -> { ok:false } (a safe no-op), never a throw.
 */
export interface NetsantralOriginateOutcome {
  ok: boolean;
  callId?: string;
  code?: string;
  message?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  '20': 'Netsantral rejected the request (bad parameters, code 20).',
  '30': 'Netsantral authentication failed: verify username/password, API access, and IP allow-list (code 30).',
  '40': 'Netsantral: extension or trunk not authorised (code 40).',
  '60': 'Netsantral: account/sub-user not authorised for this operation (code 60).',
  '70': 'Netsantral: invalid or missing request parameters (code 70).',
  '80': 'Netsantral rate limit exceeded — retry shortly (code 80).',
};

export function interpretNetsantralOriginate(rawBody: string): NetsantralOriginateOutcome {
  const body = (rawBody ?? '').trim();
  if (!body) return { ok: false, message: 'Netsantral returned an empty response.' };

  // JSON shape. The REAL success (with wait_response=0) carries NO id, e.g.
  // {"response":"linkup","status":"Originate successfully queued","message":"Success"}
  // so acceptance is by status/message, NOT the presence of a call id (the SIP id
  // arrives later on the CDR, keyed by crm_id). An explicit numeric error code
  // (e.g. {"code":"30",...}) is the only failure.
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const j = JSON.parse(body);
      const obj = Array.isArray(j) ? j[0] : j;
      const id = obj?.unique_id ?? obj?.uniqueid ?? obj?.callid ?? obj?.id;
      const code = obj?.code != null ? String(obj.code) : undefined;
      const status = String(obj?.status ?? '').toLowerCase();
      const message = String(obj?.message ?? '').toLowerCase();

      // An explicit numeric error code (other than the accept codes) → failure.
      if (code && /^\d+$/.test(code) && !['00', '01', '02'].includes(code)) {
        return { ok: false, code, message: ERROR_MESSAGES[code] ?? `Netsantral rejected the call (code ${code}).` };
      }
      // Accepted when the PBX queued it: an id, an accept status/code, or a
      // success-y status/message ("Originate successfully queued" / "Success").
      const accepted =
        !!id ||
        ['00', '01', '02', 'success', 'ok'].includes(status) ||
        status.includes('success') ||
        status.includes('queued') ||
        message.includes('success');
      if (accepted) return id ? { ok: true, callId: String(id) } : { ok: true };

      return { ok: false, code, message: 'Netsantral did not return a call id.' };
    } catch {
      return { ok: false, message: 'Netsantral returned an unreadable JSON body.' };
    }
  }

  // Plain-text: a leading status code (00/01/02 = accepted, else error).
  const code = body.split(/\s+/)[0];
  if (/^0[0-2]$/.test(code)) {
    const rest = body.slice(code.length).trim();
    return rest ? { ok: true, callId: rest } : { ok: true };
  }
  if (/^\d{2}$/.test(code)) {
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? `Netsantral rejected the call (code ${code}).` };
  }
  return { ok: false, message: 'Netsantral returned an unrecognised response.' };
}
