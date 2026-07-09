import { Injectable, Logger } from '@nestjs/common';
import { interpretNetsantralOriginate, NetsantralOriginateOutcome } from './netsantral.util';

export interface OriginateParams {
  username: string;
  password: string;
  customer_num: string;
  internal_num: string;
  trunk: string;
  pbxnum?: string;
  /** Correlation id echoed on call-event webhooks (Phase 2); use the SalesCall id. */
  crmId?: string;
  /** Ring duration (seconds) before giving up on the rep's extension. */
  ringTimeout?: number;
  /** Record both legs (caller_record/called_record). Mirrors BridgeParams.record. */
  record?: boolean;
}

export interface BridgeParams {
  username: string;
  password: string;
  /** First leg — the rep's own phone (external number). NetGSM rings this first. */
  caller: string;
  /** Second leg — the customer/lead number. */
  called: string;
  trunk: string;
  /** Correlation id echoed on call-event webhooks/CDR (Phase 2); use the SalesCall id. */
  crmId?: string;
  ringTimeout?: number;
  /** Record both legs (caller_record/called_record). Retrieval is via the report API. */
  record?: boolean;
}

/** Netsantral account credentials — the subset every control endpoint needs. */
export interface NetsantralCreds {
  username: string;
  password: string;
}

/**
 * Normalized per-agent queue state (NetGSM Phase 4 Task 4). The real
 * queuestats wire shape is an open item (same status as originate/linkup
 * before they were confirmed live) — `raw` keeps NetGSM's own string for
 * diagnosis when it doesn't map to one of the recognised buckets.
 */
export type QueueAgentState = 'available' | 'paused' | 'oncall' | 'offline' | 'unknown';

export interface QueueAgentStat {
  /** The agent's Netsantral extension (MarketingUser.dahili). */
  dahili: string;
  state: QueueAgentState;
  /** NetGSM's own state string, when it didn't match a recognised bucket. */
  raw?: string;
}

export interface QueueStat {
  /** `{santral}-queue-{name}` per NetGSM's naming convention. */
  queue: string;
  waiting: number;
  /** Average/current hold time in seconds, or null when NetGSM didn't report one. */
  holdtimeSec: number | null;
  agents: QueueAgentStat[];
}

export interface QueueStatsOutcome {
  ok: boolean;
  queues?: QueueStat[];
  code?: string;
  message?: string;
}

/**
 * Thin client for NetGSM Netsantral call control ("dış arama" / tıkla-ara).
 *
 * Two ways to place a call (endpoints confirmed from the official
 * `netgsm1/netsantral` package source, host `crmsntrl.netgsm.com.tr:9111`):
 *  - originate (`/originate`, cagribaslat): rings the rep's EXTENSION first, then
 *    the customer. Needs a registered device on that extension (webphone/Netsipp).
 *  - callBridge (`/linkup`, cagribagla): rings the rep's own PHONE and the customer
 *    as two external legs and bridges them over the trunk — needs NO extension, so
 *    it works without Netsipp. `originate_order=if` rings the rep (caller) first.
 *
 * Both show the trunk (0850) as the caller id, so the customer sees the business
 * number and the rep's personal number stays hidden.
 *
 * Also hosts the Phase 3 Task 5 in-call controls (hangup/xfer/atxfer/muteaudio)
 * and the Phase 4 Task 4 queue wallboard + agent presence (queuestats,
 * agentlogin/agentlogoff/agentpause) — all plain GETs on the same crmsntrl
 * host, same query-string-auth shape.
 *
 * SECURITY: this PBX endpoint is plain HTTP (port 9111) and takes credentials in
 * the query string — NetGSM's design, not ours. So we NEVER log the URL and we
 * scrub username+password from any error. Inert until a workspace has an ACTIVE
 * TelephonyConfig.
 */
@Injectable()
export class NetsantralClient {
  private readonly logger = new Logger(NetsantralClient.name);
  static readonly ORIGINATE_HOST = 'http://crmsntrl.netgsm.com.tr:9111';
  private static readonly TIMEOUT_MS = 15_000;
  private static readonly DEFAULT_RING_TIMEOUT = 30;

  /** Ring the rep's extension first, then the customer (api-dial; needs a device on the extension). */
  async originate(p: OriginateParams): Promise<NetsantralOriginateOutcome> {
    if (!p?.username || !p?.password || !p?.customer_num || !p?.internal_num || !p?.trunk) {
      return { ok: false, message: 'Netsantral originate called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: p.username,
      password: p.password,
      customer_num: p.customer_num.replace(/[^\d]/g, ''),
      pbxnum: p.pbxnum ?? '',
      internal_num: p.internal_num,
      ring_timeout: String(p.ringTimeout ?? NetsantralClient.DEFAULT_RING_TIMEOUT),
      crm_id: p.crmId ?? '',
      wait_response: '0',
      // ring the rep's extension first, then the customer (matches the package default)
      originate_order: 'if',
      trunk: p.trunk.replace(/[^\d]/g, ''),
    });
    if (p.record) {
      qs.set('caller_record', '1');
      qs.set('called_record', '1');
    }
    return this.call('originate', p.username, qs, p.password);
  }

  /**
   * Bridge two external numbers: ring the rep's own phone (`caller`) and the
   * customer (`called`), connect them over the trunk. No extension/softphone
   * needed — the no-Netsipp click-to-call path.
   */
  async callBridge(p: BridgeParams): Promise<NetsantralOriginateOutcome> {
    if (!p?.username || !p?.password || !p?.caller || !p?.called || !p?.trunk) {
      return { ok: false, message: 'Netsantral callBridge called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: p.username,
      password: p.password,
      caller: p.caller.replace(/[^\d]/g, ''),
      called: p.called.replace(/[^\d]/g, ''),
      ring_timeout: String(p.ringTimeout ?? NetsantralClient.DEFAULT_RING_TIMEOUT),
      crm_id: p.crmId ?? '',
      wait_response: '0',
      // ring the rep (caller/first leg) first, then the customer
      originate_order: 'if',
      trunk: p.trunk.replace(/[^\d]/g, ''),
    });
    if (p.record) {
      qs.set('caller_record', '1');
      qs.set('called_record', '1');
    }
    return this.call('linkup', p.username, qs, p.password);
  }

  /**
   * Hang up the LIVE call (Phase 3 Task 5 — in-call controls). Needs the
   * santral `unique_id`, which only arrives later via the event webhook and
   * gets backfilled onto `SalesCall.externalCallId` (see
   * TelephonyEventConsumer) — there is no way to hang up a call before that.
   */
  async hangup(creds: NetsantralCreds, uniqueId: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId) {
      return { ok: false, message: 'Netsantral hangup called with missing parameters.' };
    }
    const qs = new URLSearchParams({ username: creds.username, password: creds.password, unique_id: uniqueId });
    return this.call('hangup', creds.username, qs, creds.password);
  }

  /** Blind transfer (`xfer`) — hand the LIVE call off to another extension, this leg drops immediately. */
  async blindTransfer(creds: NetsantralCreds, uniqueId: string, exten: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId || !exten) {
      return { ok: false, message: 'Netsantral blindTransfer called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: creds.username, password: creds.password, unique_id: uniqueId, exten,
    });
    return this.call('xfer', creds.username, qs, creds.password);
  }

  /** Attended transfer (`atxfer`) — consult the target extension before the handoff completes. */
  async attendedTransfer(creds: NetsantralCreds, uniqueId: string, exten: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId || !exten) {
      return { ok: false, message: 'Netsantral attendedTransfer called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: creds.username, password: creds.password, unique_id: uniqueId, exten,
    });
    return this.call('atxfer', creds.username, qs, creds.password);
  }

  /**
   * Mute/unmute (`muteaudio`) one side of the LIVE call. NOTE: the exact
   * on/off toggle field is an open item (same status as originate/linkup's
   * wire shape before it was confirmed live — see the class docstring) —
   * `mute=1|0` is the best-effort guess; adjust here if NetGSM's real field
   * differs once confirmed against a live account.
   */
  async mute(creds: NetsantralCreds, uniqueId: string, on: boolean): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !uniqueId) {
      return { ok: false, message: 'Netsantral mute called with missing parameters.' };
    }
    const qs = new URLSearchParams({
      username: creds.username, password: creds.password, unique_id: uniqueId, mute: on ? '1' : '0',
    });
    return this.call('muteaudio', creds.username, qs, creds.password);
  }

  // ── Phase 4 Task 4: queue wallboard + agent presence ──────────────────────

  /**
   * `queuestats` (GET, crmsntrl host) — per-queue waiting/holdtime + per-agent
   * state, tolerantly parsed since the exact response shape is unconfirmed.
   * Pass `queueName` (`{santral}-queue-{name}`) to filter to one queue;
   * omitted fetches every queue the account can see. Only DYNAMIC queue
   * members are reflected reliably here / manageable via agentLogin etc. —
   * static members added in the NetGSM portal UI may not report state.
   */
  async queueStats(creds: NetsantralCreds, queueName?: string): Promise<QueueStatsOutcome> {
    if (!creds?.username || !creds?.password) {
      return { ok: false, message: 'Netsantral queueStats called with missing parameters.' };
    }
    const qs = new URLSearchParams({ username: creds.username, password: creds.password });
    if (queueName) qs.set('queue', queueName);
    const raw = await this.fetchRaw('queuestats', creds.username, qs, creds.password);
    if (!raw.ok) return { ok: false, message: raw.message };
    return this.interpretQueueStats(raw.text);
  }

  /** `agentlogin` — mark the rep's extension available to take queue calls ("available" presence). */
  async agentLogin(creds: NetsantralCreds, dahili: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !dahili) {
      return { ok: false, message: 'Netsantral agentLogin called with missing parameters.' };
    }
    const qs = new URLSearchParams({ username: creds.username, password: creds.password, exten: dahili });
    return this.call('agentlogin', creds.username, qs, creds.password);
  }

  /** `agentlogoff` — log the rep's extension out of the queue entirely. */
  async agentLogoff(creds: NetsantralCreds, dahili: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !dahili) {
      return { ok: false, message: 'Netsantral agentLogoff called with missing parameters.' };
    }
    const qs = new URLSearchParams({ username: creds.username, password: creds.password, exten: dahili });
    return this.call('agentlogoff', creds.username, qs, creds.password);
  }

  /** `agentpause` — put the rep's extension on a break, with an optional reason string. */
  async agentPause(creds: NetsantralCreds, dahili: string, reason?: string): Promise<NetsantralOriginateOutcome> {
    if (!creds?.username || !creds?.password || !dahili) {
      return { ok: false, message: 'Netsantral agentPause called with missing parameters.' };
    }
    const qs = new URLSearchParams({ username: creds.username, password: creds.password, exten: dahili });
    if (reason) qs.set('reason', reason);
    return this.call('agentpause', creds.username, qs, creds.password);
  }

  /** Tolerant queuestats body parser — never throws; unrecognised shapes → empty/`unknown`, not a crash. */
  private interpretQueueStats(rawBody: string): QueueStatsOutcome {
    const body = (rawBody ?? '').trim();
    if (!body) return { ok: false, message: 'Netsantral returned an empty response.' };

    if (!(body.startsWith('{') || body.startsWith('['))) {
      // Plain-text: same leading-status-code convention as originate/hangup.
      const code = body.split(/\s+/)[0];
      if (/^\d{2}$/.test(code) && !/^0[0-2]$/.test(code)) {
        return { ok: false, code, message: `Netsantral rejected the request (code ${code}).` };
      }
      return { ok: false, message: 'Netsantral returned an unrecognised response.' };
    }

    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return { ok: false, message: 'Netsantral returned an unreadable JSON body.' };
    }

    const status = String(j?.status ?? '');
    if (!Array.isArray(j) && (j?.code != null || /error|hata/i.test(status))) {
      const code = j?.code != null ? String(j.code) : undefined;
      const message = typeof j?.message === 'string' && j.message.trim() ? j.message.trim() : undefined;
      return { ok: false, code, message: message ?? 'Netsantral rejected the queuestats request.' };
    }

    const list: any[] = Array.isArray(j)
      ? j
      : Array.isArray(j?.queues)
        ? j.queues
        : Array.isArray(j?.data)
          ? j.data
          : j && typeof j === 'object'
            ? [j]
            : [];

    const queues = list.filter((q) => q && typeof q === 'object').map((q) => this.parseQueueEntry(q));
    return { ok: true, queues };
  }

  private parseQueueEntry(q: any): QueueStat {
    const queue = String(q.queue ?? q.queue_name ?? q.queueName ?? q.name ?? q.kuyruk ?? '').trim();
    const waitingRaw = q.waiting ?? q.calls_waiting ?? q.callsWaiting ?? q.waitingCount ?? q.bekleyen ?? 0;
    const waiting = Number.parseInt(String(waitingRaw), 10);
    const holdtimeRaw =
      q.holdtimeSec ?? q.holdtime_sec ?? q.holdtime ?? q.hold_time ?? q.avgHoldtime ?? q.avg_holdtime ?? null;
    const holdtimeSec = this.parseHoldtime(holdtimeRaw);
    const agentsRaw: any[] = Array.isArray(q.agents)
      ? q.agents
      : Array.isArray(q.members)
        ? q.members
        : Array.isArray(q.uyeler)
          ? q.uyeler
          : [];
    const agents = agentsRaw
      .filter((a) => a && typeof a === 'object')
      .map((a) => {
        const dahili = String(a.dahili ?? a.exten ?? a.extension ?? a.internal_num ?? a.member ?? '').trim();
        const rawState = String(a.state ?? a.status ?? a.durum ?? '').trim();
        const stat: QueueAgentStat = { dahili, state: this.normalizeAgentState(rawState) };
        if (rawState) stat.raw = rawState;
        return stat;
      })
      .filter((a) => a.dahili);
    return { queue, waiting: Number.isFinite(waiting) ? waiting : 0, holdtimeSec, agents };
  }

  /** `"90"` -> 90, `"1:30"`/`"01:30:00"` -> seconds, unreadable -> null (never throws). */
  private parseHoldtime(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
      const parts = [m[1], m[2], m[3]].filter((x) => x != null).map(Number);
      return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    }
    return null;
  }

  private normalizeAgentState(raw: string): QueueAgentState {
    const s = raw.toLowerCase();
    if (!s) return 'unknown';
    if (/avail|müsait|musait|idle|ready|login/.test(s)) return 'available';
    if (/pause|break|mola/.test(s)) return 'paused';
    if (/oncall|busy|meşgul|mesgul|talking|inuse|ringing/.test(s)) return 'oncall';
    if (/offline|logoff|logged.?out|kapal/.test(s)) return 'offline';
    return 'unknown';
  }

  /** Shared GET + status check + tolerant interpret + credential scrubbing. */
  private async call(
    path: 'originate' | 'linkup' | 'hangup' | 'xfer' | 'atxfer' | 'muteaudio' | 'agentlogin' | 'agentlogoff' | 'agentpause',
    username: string,
    qs: URLSearchParams,
    password: string,
  ): Promise<NetsantralOriginateOutcome> {
    const raw = await this.fetchRaw(path, username, qs, password);
    if (!raw.ok) return { ok: false, message: raw.message };
    const outcome = interpretNetsantralOriginate(raw.text);
    if (!outcome.ok) {
      // Make the real wire shape visible for diagnosis WITHOUT leaking PII:
      // mask any 7+ digit run (phone numbers/msisdn) and cap length. Creds live
      // in the query string, not the body, so the body is otherwise safe to log.
      const safeBody = raw.text.replace(/\d{7,}/g, '***').slice(0, 500);
      this.logger.warn(`netsantral ${path} not ok: ${outcome.message ?? outcome.code ?? '?'} | body=${safeBody}`);
    }
    return outcome;
  }

  /**
   * Shared GET + HTTP-status check + thrown-error credential scrubbing (no
   * response-body interpretation). Deliberately NOT a discriminated union —
   * this repo builds with `strictNullChecks: false`, under which TS cannot
   * narrow a `{ok:true;text}|{ok:false;message}` union via `if (!raw.ok)`, so
   * both fields are always present (empty `text`/absent `message` on the
   * unused side) and every caller just reads `raw.ok`/`raw.text`/`raw.message`.
   */
  private async fetchRaw(
    path: string,
    username: string,
    qs: URLSearchParams,
    password: string,
  ): Promise<{ ok: boolean; text: string; message?: string }> {
    try {
      const url = `${NetsantralClient.ORIGINATE_HOST}/${encodeURIComponent(username)}/${path}?${qs.toString()}`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(NetsantralClient.TIMEOUT_MS),
      });
      if (typeof res.status === 'number' && res.status >= 400) {
        // never log the url — it carries the credentials in the query string
        this.logger.warn(`netsantral ${path} HTTP ${res.status}`);
        return { ok: false, text: '', message: `Netsantral HTTP ${res.status}` };
      }
      const text = (await res.text()) ?? '';
      return { ok: true, text };
    } catch (e: any) {
      const timedOut = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      const raw = timedOut ? 'Netsantral request timed out' : (e?.message ?? String(e));
      // The URL carries username+password in the query — scrub both from any error.
      const escaped = password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const scrubbed = raw
        .replace(/password=[^&\s]+/gi, 'password=***')
        .replace(/username=[^&\s]+/gi, 'username=***')
        .replace(new RegExp(escaped, 'g'), '***');
      return { ok: false, text: '', message: scrubbed };
    }
  }
}
