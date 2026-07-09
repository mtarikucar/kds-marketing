import { Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

type NetgsmCreds = { usercode: string; password: string };

/** Menu/branch structure for multi-key (press-1, press-2, ...) voice scenarios.
 *  `series` shape isn't pinned down by NetGSM's docs yet — passed through as-is. */
export interface VoicesmsScenario {
  series?: unknown[];
  [key: string]: unknown;
}

export interface VoicesmsSendRequest {
  /** Built-in Turkish TTS text. Exactly one of `msg`/`audioid` is required. */
  msg?: string;
  /** An `audioid` returned by `upload()` — a pre-uploaded .wav to play instead of TTS. */
  audioid?: string;
  no: string;
  iysfilter?: '0' | '11' | '12';
  brandcode?: string;
  /** Caller's own correlation id (our CampaignRecipient id) — echoed back on the voice-report webhook. */
  relationid?: string;
  /** Our voice-report webhook URL — NetGSM PUSHES call outcomes here (unlike SMS DLR, which is polled). */
  url?: string;
  /** DTMF digits the callee may press for a press-1-style branch capture. */
  keys?: string[];
  scenario?: VoicesmsScenario;
}

export interface VoicesmsSendResult {
  ok: boolean;
  code: string;
  jobid: string | null;
  relationid: string | null;
  message: string | null;
  retriable: boolean;
  /** True ONLY when the request never reached NetGSM at all (a thrown
   *  network/timeout error) — nothing was ever accepted, so a retry is safe.
   *  False for every other outcome, including a 200 whose body couldn't be
   *  parsed: NetGSM may already have placed/billed the call, so retrying risks
   *  a duplicate. Mirrors `SmsV2Client.doSend`'s money-path idiom. */
  transport: boolean;
}

export interface VoicesmsUploadResult {
  ok: boolean;
  audioid: string | null;
  message: string | null;
}

export interface VoicesmsCancelResult {
  ok: boolean;
  code: string | null;
  message: string | null;
}

/** Only transient throttling (80) eases on its own — mirrors SmsV2Client/interpretNetgsmSend. */
const RETRIABLE_CODES = new Set(['80']);

/** NetGSM's documented voice-upload cap. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * NetGSM voice-campaign SEND client — `/voicesms/send` (TTS/audio blast,
 * JSON), `/voicesms/upload` (multipart .wav → `audioid`), `/voicesms/edit`
 * (cancel a pending job). SIBLING of `VoicesmsClient` (`/voicesms/receive`,
 * telesekreter voicemail) — deliberately NOT modified here; this is a
 * separate class for the outbound half. Same host, same raw-JSON-body-creds
 * transport (usercode/password IN the body, not the REST v2 Basic-Auth
 * `NetgsmRestClient` transport `/sms/rest/v2/*` uses), same tolerant
 * multi-alias parsing philosophy, same `{code, error}` pre-auth/off-prod
 * rejection envelope as `VoicesmsClient`/`NetgsmCdrClient`/`NetgsmStatisticsClient`.
 * Never logs credentials — a transport error's message can echo the POST
 * body, so both cred values are scrubbed before any log line.
 *
 * `send()`'s result shape mirrors `SmsV2Client.doSend`'s money-path idiom:
 * `transport: true` ONLY for a genuine network/timeout failure (nothing was
 * ever sent, safe to retry); every other outcome — including a 200 whose body
 * couldn't be parsed — is `transport: false`, because NetGSM may already have
 * placed/billed the call. `retriable` is `true` ONLY for code '80' (rate
 * limit); every other code needs a fix, not a retry.
 *
 * Response field names (jobid/relationid/audioid casing, the `{code, error}`
 * envelope) are researched from NetGSM's documented voice-campaign contract,
 * not yet live-verified against a real account — same "researched, not yet
 * live-verified" status the sibling CDR/statistics/voicemail clients carried
 * before their own live confirmation. Parsing stays tolerant of aliases so a
 * real account's actual field names slot in without a rewrite; the request
 * field names we SEND (e.g. `dosya` for the upload's file field) are our
 * best-effort match to NetGSM's Turkish-first classic-API naming and should
 * be confirmed against a live account before go-live.
 */
@Injectable()
export class VoicesmsSendClient {
  private readonly logger = new Logger(VoicesmsSendClient.name);
  static readonly SEND_URL = 'https://api.netgsm.com.tr/voicesms/send';
  static readonly UPLOAD_URL = 'https://api.netgsm.com.tr/voicesms/upload';
  static readonly EDIT_URL = 'https://api.netgsm.com.tr/voicesms/edit';

  /** TTS/audio voice blast. Exactly one of `msg`/`audioid` must be set —
   *  validated here so a malformed request never burns a billed call attempt. */
  async send(creds: NetgsmCreds, req: VoicesmsSendRequest): Promise<VoicesmsSendResult> {
    if (!req.msg && !req.audioid) {
      return {
        ok: false, code: '', jobid: null, relationid: req.relationid ?? null,
        message: 'İstek `msg` (TTS metni) veya `audioid` (yüklenmiş ses dosyası) alanlarından birini içermelidir.',
        retriable: false, transport: false,
      };
    }
    const body: Record<string, unknown> = {
      usercode: creds.usercode,
      password: creds.password,
      no: req.no,
    };
    if (req.msg !== undefined) body.msg = req.msg;
    if (req.audioid !== undefined) body.audioid = req.audioid;
    if (req.iysfilter !== undefined) body.iysfilter = req.iysfilter;
    if (req.brandcode !== undefined) body.brandcode = req.brandcode;
    if (req.relationid !== undefined) body.relationid = req.relationid;
    if (req.url !== undefined) body.url = req.url;
    if (req.keys !== undefined) body.keys = req.keys;
    if (req.scenario !== undefined) body.scenario = req.scenario;

    let respBody: any;
    try {
      const res = await safeFetch(VoicesmsSendClient.SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      // A transport error's message can echo the POST body (usercode/password).
      // Scrub both cred values before logging — mirrors VoicesmsClient/NetgsmCdrClient.
      this.logger.warn(`netgsm voicesms send transport error: ${this.scrub(e, creds)}`);
      return {
        ok: false, code: '', jobid: null, relationid: req.relationid ?? null,
        message: 'NetGSM sesli arama isteğine ulaşılamadı.', retriable: false, transport: true,
      };
    }
    if (!respBody) {
      return {
        ok: false, code: '', jobid: null, relationid: req.relationid ?? null,
        message: 'NetGSM boş yanıt döndürdü.', retriable: false, transport: false,
      };
    }
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code == null) {
      // An HTTP response WAS received but carried no recognizable code — NetGSM
      // may already have placed the call, so this must NOT be treated as retriable.
      return {
        ok: false, code: '', jobid: null, relationid: req.relationid ?? null,
        message: 'NetGSM beklenmedik yanıt döndürdü.', retriable: false, transport: false,
      };
    }
    if (code !== '00') {
      const message =
        typeof respBody.error === 'string' && respBody.error.trim()
          ? respBody.error.trim()
          : netgsmErrorMessage(code);
      this.logger.warn(`netgsm voicesms send error code=${code} ${message}`);
      return {
        ok: false, code, jobid: null, relationid: req.relationid ?? null,
        message, retriable: RETRIABLE_CODES.has(code), transport: false,
      };
    }
    const jobid = pick(respBody, ['jobid', 'jobId', 'JobID', 'id']);
    const relationid = pick(respBody, ['relationid', 'relationId', 'RelationID']) ?? req.relationid ?? null;
    return {
      ok: true, code, jobid: jobid != null ? String(jobid) : null,
      relationid: relationid != null ? String(relationid) : null,
      message: null, retriable: false, transport: false,
    };
  }

  /** Multipart .wav upload → an `audioid` usable as `send()`'s `audioid`.
   *  NetGSM's documented ≤4MB cap is enforced here first, before ever hitting
   *  the network (mirrors `SmsV2Client.otp`'s pre-flight-validate philosophy). */
  async upload(creds: NetgsmCreds, wav: Buffer, name: string): Promise<VoicesmsUploadResult> {
    if (!Buffer.isBuffer(wav) || wav.length === 0) {
      return { ok: false, audioid: null, message: 'Yüklenecek ses dosyası boş.' };
    }
    if (wav.length > MAX_UPLOAD_BYTES) {
      return { ok: false, audioid: null, message: "Ses dosyası NetGSM sınırı olan 4MB'ı aşıyor." };
    }
    const form = new FormData();
    form.append('usercode', creds.usercode);
    form.append('password', creds.password);
    form.append('dosya', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), name);

    let respBody: any;
    try {
      const res = await safeFetch(VoicesmsSendClient.UPLOAD_URL, {
        method: 'POST',
        body: form,
        timeoutMs: 30_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm voicesms upload transport error: ${this.scrub(e, creds)}`);
      return { ok: false, audioid: null, message: 'NetGSM ses yükleme isteğine ulaşılamadı.' };
    }
    if (!respBody) return { ok: false, audioid: null, message: 'NetGSM boş yanıt döndürdü.' };
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code && code !== '00') {
      const message =
        typeof respBody.error === 'string' && respBody.error.trim()
          ? respBody.error.trim()
          : netgsmErrorMessage(code);
      this.logger.warn(`netgsm voicesms upload error code=${code} ${message}`);
      return { ok: false, audioid: null, message };
    }
    const audioid = pick(respBody, ['audioid', 'audioId', 'AudioID', 'id']);
    if (audioid == null) {
      return { ok: false, audioid: null, message: 'NetGSM audioid döndürmedi.' };
    }
    return { ok: true, audioid: String(audioid), message: null };
  }

  /** Cancel a pending (not-yet-delivered) voice job. */
  async cancel(creds: NetgsmCreds, jobid: string): Promise<VoicesmsCancelResult> {
    const body = { usercode: creds.usercode, password: creds.password, jobid };
    let respBody: any;
    try {
      const res = await safeFetch(VoicesmsSendClient.EDIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      respBody = await res.json().catch(() => null);
    } catch (e: any) {
      this.logger.warn(`netgsm voicesms cancel transport error: ${this.scrub(e, creds)}`);
      return { ok: false, code: null, message: 'NetGSM iptal isteğine ulaşılamadı.' };
    }
    if (!respBody) return { ok: false, code: null, message: 'NetGSM boş yanıt döndürdü.' };
    const code = respBody.code != null ? String(respBody.code) : null;
    if (code && code !== '00') {
      const message =
        typeof respBody.error === 'string' && respBody.error.trim()
          ? respBody.error.trim()
          : netgsmErrorMessage(code);
      this.logger.warn(`netgsm voicesms cancel error code=${code} ${message}`);
      return { ok: false, code, message };
    }
    return { ok: true, code: code ?? '00', message: null };
  }

  /** Scrub both cred values out of a thrown transport error's message before it's
   *  ever logged — a timeout/DNS error can echo the POST body verbatim. */
  private scrub(e: any, creds: NetgsmCreds): string {
    return String(e?.message ?? e)
      .split(creds.password).join('***')
      .split(creds.usercode).join('***');
  }
}

const pick = (o: any, keys: string[]): any => {
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  }
  return undefined;
};
