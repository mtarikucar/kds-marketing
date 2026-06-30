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

  // JSON shape (real Netsantral linkup/originate, captured live from
  // crmsntrl.netgsm.com.tr:9111):
  //   ACCEPTED: { response:"linkup", caller_num, called_num, crm_id,
  //              status:"Originate successfully queued", message:"Success" }
  //   FAILED:   { code:"30", status:"Error", message:"Eksik yada yanlis parametre" }
  //             { status:"Error", message:"Kullanici dogrulanamadi" }
  // CRUCIAL: with wait_response=0 the ACCEPTED response carries NO unique_id —
  // the SIP id arrives later on the CDR webhook (correlated by `crm_id`). So the
  // acceptance signal is the status/message ("...queued" / "Success"), NOT a call
  // id. (We previously required a unique_id and wrongly marked every placed call
  // CANCELLED with the misleading "did not return a call id".)
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const j = JSON.parse(body);
      const obj = Array.isArray(j) ? j[0] : j;
      const idRaw = obj?.unique_id ?? obj?.uniqueid ?? obj?.uniqueId ?? obj?.callid ?? obj?.callId ?? obj?.id;
      const id = idRaw != null ? String(idRaw).trim() : '';
      const status = String(obj?.status ?? '');
      const message = typeof obj?.message === 'string' ? obj.message.trim() : '';
      const response = String(obj?.response ?? '').toLowerCase();

      // Explicit failure: status "Error", a Turkish "hata", or a numeric code.
      const failed = obj?.code != null || /error|fail|hata/i.test(status);
      // Acceptance: NetGSM queued the call. Signalled by a SIP id, a queued/
      // success status, a "success" message, or the echoed response verb.
      const accepted =
        !failed &&
        (!!id ||
          /success|queued|originate|accepted|ok|01|02|00/i.test(status) ||
          /^success$/i.test(message) ||
          response === 'linkup' ||
          response === 'originate');

      if (accepted) {
        return id ? { ok: true, callId: id } : { ok: true };
      }

      // Failure: surface NetGSM's OWN reason verbatim (`message`/`status`), then
      // the legacy numeric `code` map, then a generic line — so the operator sees
      // auth ("Kullanici dogrulanamadi") / param ("Eksik...") errors as-is.
      const code = obj?.code != null ? String(obj.code) : undefined;
      const reason =
        message ||
        (code && ERROR_MESSAGES[code]) ||
        (status ? `Netsantral rejected the call (${status}).` : 'Netsantral did not return a call id.');
      return { ok: false, code, message: reason };
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
