import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

type NetgsmCreds = { usercode: string; password: string };

/** The ONLY Meta-approved template NetGSM's WhatsApp OTP surface sends — no
 *  free-form WhatsApp messaging exists on this product, by design (brief-pinned
 *  fact: "FIXED netgsm_verify_code Meta template only"). */
export const WHATSAPP_VERIFY_TEMPLATE = 'netgsm_verify_code';

export interface WhatsAppOtpSendRequest {
  /** Recipient's WhatsApp-registered phone number. */
  to: string;
  /** The OTP code — the template's sole body variable. */
  code: string;
}

export interface WhatsAppOtpSendResult {
  ok: boolean;
  code: string;
  message: string | null;
  /** Only code '80' (rate limit) eases on its own — mirrors every other NetGSM send surface. */
  retriable: boolean;
  /** True ONLY when the request never reached NetGSM at all (a thrown
   *  network/timeout error) — nothing was ever accepted, so a retry is safe.
   *  False for every other outcome, including a 200 whose body couldn't be
   *  parsed: NetGSM may already have queued/billed the message. Mirrors
   *  `SmsV2Client.doSend`/`FaxClient.send`'s money-path idiom. */
  transport: boolean;
}

/** Only transient throttling (80) eases on its own — mirrors every other NetGSM send surface. */
const RETRIABLE_CODES = new Set(['80']);

/**
 * NetGSM WhatsApp OTP client (NetGSM Phase 6 Task 3) — `whatsappapi.netgsm.com.tr`,
 * a SEPARATE host from the classic/REST-v2 SMS surfaces, offering exactly ONE
 * capability: sending the fixed, Meta-approved `netgsm_verify_code` template
 * with the OTP code + the recipient as its template parameters. There is no
 * free-form WhatsApp messaging here — this client is purely an alternate
 * DELIVERY TRANSPORT for `SmsOtpService` (Phase 1), never a substitute for the
 * `WHATSAPP` channel type (Meta Cloud API) used elsewhere for real
 * conversations.
 *
 * Requires a paid "OTP WhatsApp" package + Meta template approval on the
 * account — absent either, NetGSM answers with a non-'00' error code (the
 * exact code is unconfirmed pending a live account, same "researched, not yet
 * live-verified" status the sibling fax/voice-campaign clients carried before
 * their own live confirmation). `SmsOtpService` treats ANY non-ok result here
 * — a real send error, a missing package, or a transport fault — identically:
 * fall back to SMS, never leave a code undelivered.
 *
 * Uses the SAME NetGSM account credentials (usercode/password) as the
 * workspace's SMS channel — per the hub design spec, `Channel.configSealed`
 * seals one shared usercode across SMS/İYS/voice/fax/balance/OTP, so this
 * client takes creds as a plain argument like every other hub client rather
 * than resolving its own credential store.
 *
 * Same transport philosophy as the sibling niche clients (`fax.client.ts`,
 * `voicesms-send.client.ts`): raw JSON body with `usercode`/`password`
 * in-body (NOT the REST v2 Basic-Auth transport `NetgsmRestClient` provides),
 * tolerant `{code, error}` pre-auth/off-prod rejection-envelope parsing, never
 * logs credentials — a transport error's message can echo the request, so
 * both cred values are scrubbed before any log line. The request field names
 * sent on the wire (`no` for the recipient, `template` for the fixed template
 * name, `params` for its body variables) are our best-effort match to
 * NetGSM's documented WhatsApp Business template contract and should be
 * confirmed against a live account before go-live.
 */
@Injectable()
export class WhatsAppOtpClient {
  private readonly logger = new Logger(WhatsAppOtpClient.name);
  static readonly SEND_URL = 'https://whatsappapi.netgsm.com.tr/api/send';
  static readonly TEMPLATE = WHATSAPP_VERIFY_TEMPLATE;

  /** Send the fixed `netgsm_verify_code` template to `req.to` with `req.code`
   *  as its body parameter. Rejects a blank recipient/code BEFORE ever
   *  touching the network — mirrors `FaxClient.send`'s pre-flight-validate
   *  philosophy. */
  async sendVerifyCode(creds: NetgsmCreds, req: WhatsAppOtpSendRequest): Promise<WhatsAppOtpSendResult> {
    if (!req.to || !req.to.trim()) {
      return { ok: false, code: '', message: 'Alıcı WhatsApp numarası gerekli.', retriable: false, transport: false };
    }
    if (!req.code || !req.code.trim()) {
      return { ok: false, code: '', message: 'Doğrulama kodu gerekli.', retriable: false, transport: false };
    }

    const body = {
      usercode: creds.usercode,
      password: creds.password,
      no: req.to,
      template: WHATSAPP_VERIFY_TEMPLATE,
      // The fixed template's only body variables — the code and the
      // recipient, in that order (brief-pinned: "params = the code +
      // the recipient").
      params: [req.code, req.to],
    };

    let respBody: any;
    try {
      const res = await safeFetch(WhatsAppOtpClient.SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      // A transport error's message can echo the request — scrub both cred
      // values before logging, mirrors FaxClient/VoicesmsSendClient.
      this.logger.warn(`netgsm whatsapp otp send transport error: ${this.scrub(e, creds)}`);
      return {
        ok: false, code: '', message: 'NetGSM WhatsApp OTP isteğine ulaşılamadı.', retriable: false, transport: true,
      };
    }
    if (!respBody) {
      return { ok: false, code: '', message: 'NetGSM boş yanıt döndürdü.', retriable: false, transport: false };
    }
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code == null) {
      // An HTTP response WAS received but carried no recognizable code —
      // NetGSM may already have queued the message, so this must NOT be retriable.
      return { ok: false, code: '', message: 'NetGSM beklenmedik yanıt döndürdü.', retriable: false, transport: false };
    }
    if (code !== '00') {
      const message =
        typeof respBody.error === 'string' && respBody.error.trim()
          ? respBody.error.trim()
          : netgsmErrorMessage(code);
      this.logger.warn(`netgsm whatsapp otp send error code=${code} ${message}`);
      return { ok: false, code, message, retriable: RETRIABLE_CODES.has(code), transport: false };
    }
    return { ok: true, code, message: null, retriable: false, transport: false };
  }

  /** Scrub both cred values out of a thrown transport error's message before
   *  it's ever logged — a timeout/DNS error can echo the request verbatim. */
  private scrub(e: any, creds: NetgsmCreds): string {
    return String(e?.message ?? e)
      .split(creds.password).join('***')
      .split(creds.usercode).join('***');
  }
}
