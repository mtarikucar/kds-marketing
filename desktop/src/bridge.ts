import { AdbError, describeDevice, execute, listDevices } from './adb';

/**
 * The loop that connects a phone on a desk to a workspace in a datacentre.
 *
 * It is a POLL, not a socket, and that is the design rather than a shortcut:
 * a laptop lid closes, a hotel wifi drops, a VPN reconnects. A poll that misses
 * is a poll that happens two seconds later; a socket that dies needs its own
 * reconnect, backoff and duplicate-delivery story before it is as reliable as
 * the naive thing.
 */

export interface BridgeConfig {
  /** e.g. https://jeetagrowth.com */
  baseUrl: string;
  apiKey: string;
  deviceId: string;
  /** ADB serial. Set once the operator has picked which phone this is. */
  serial: string;
}

export interface ClaimedCommand {
  id: string;
  kind: string;
  args: Record<string, unknown>;
  description: string;
  requiresApproval: boolean;
}

/** How the UI asks the person. Returning false is a REFUSAL, which the server
 *  records as its own outcome — not as a failure. */
export type ApprovalFn = (cmd: ClaimedCommand) => Promise<boolean>;

export interface BridgeEvents {
  onStatus?: (text: string) => void;
  onCommand?: (cmd: ClaimedCommand, outcome: string) => void;
  onError?: (message: string) => void;
}

const IDLE_POLL_MS = 2000;
/** After a network failure. Not aggressive: a bridge that hammers a server it
 *  cannot reach turns one person's flaky wifi into everyone's outage. */
const ERROR_BACKOFF_MS = 10_000;
const HEARTBEAT_EVERY_MS = 30_000;

export class Bridge {
  private running = false;
  private lastBeat = 0;
  /** Wakes the loop out of a sleep so stopping is immediate.
   *
   *  Without it `stop()` is a request the loop honours whenever its current
   *  wait happens to end — up to the ten-second error backoff. Somebody
   *  pressing stop on a phone that is doing something they did not expect
   *  should not have to watch it finish. */
  private wake: (() => void) | null = null;

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly approve: ApprovalFn,
    private readonly events: BridgeEvents = {},
  ) {}

  stop(): void {
    this.running = false;
    this.wake?.();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.events.onStatus?.('Bağlanıyor…');

    while (this.running) {
      try {
        await this.beatIfDue();
        const cmd = await this.claim();
        if (!cmd) {
          await this.sleep(IDLE_POLL_MS);
          continue;
        }
        await this.handle(cmd);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.events.onError?.(message);
        this.events.onStatus?.('Bağlantı sorunu — yeniden denenecek');
        await this.sleep(ERROR_BACKOFF_MS);
      }
    }
    this.events.onStatus?.('Durduruldu');
  }


  private async handle(cmd: ClaimedCommand): Promise<void> {
    // The person is asked BEFORE the phone is touched, and they are asked with
    // the server's own sentence. If the bridge composed its own description
    // here, what somebody consented to and what was queued could drift apart.
    if (cmd.requiresApproval) {
      this.events.onStatus?.('Onayınız bekleniyor');
      const ok = await this.approve(cmd);
      if (!ok) {
        await this.report(cmd.id, { status: 'REFUSED' });
        this.events.onCommand?.(cmd, 'Reddedildi');
        return;
      }
    }

    this.events.onStatus?.(cmd.description);
    try {
      const outcome = await execute(this.cfg.serial, cmd.kind, cmd.args);
      await this.report(cmd.id, {
        status: 'DONE',
        result: outcome.result,
        // A screenshot is evidence of what the phone actually did. It is
        // uploaded separately by the caller of this class when a store is
        // configured; here it rides as base64 only when small enough to be
        // worth the round trip.
        ...(outcome.screenshot && outcome.screenshot.length < 3_000_000
          ? { result: { ...(outcome.result ?? {}), screenshotBase64: outcome.screenshot.toString('base64') } }
          : {}),
      });
      this.events.onCommand?.(cmd, 'Yapıldı');
    } catch (e) {
      const message = e instanceof AdbError ? e.message : e instanceof Error ? e.message : String(e);
      // A phone that refused is not a bridge that broke: report it and keep
      // polling, or one bad command stops every command after it.
      await this.report(cmd.id, { status: 'FAILED', error: message });
      this.events.onCommand?.(cmd, `Olmadı: ${message}`);
    }
  }

  private async beatIfDue(): Promise<void> {
    if (Date.now() - this.lastBeat < HEARTBEAT_EVERY_MS) return;
    const info = await describeDevice(this.cfg.serial).catch(() => ({ serial: this.cfg.serial }));
    await this.post(`/api/marketing/device-bridge/${this.cfg.deviceId}/heartbeat`, { properties: info });
    this.lastBeat = Date.now();
    this.events.onStatus?.('Bağlı — komut bekleniyor');
  }

  private claim(): Promise<ClaimedCommand | null> {
    return this.post(`/api/marketing/device-bridge/${this.cfg.deviceId}/claim`, {});
  }

  private report(commandId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.post(`/api/marketing/device-bridge/commands/${commandId}/complete`, body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.cfg.apiKey },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401 || res.status === 403) {
      // Stop rather than retry: a revoked key is somebody deliberately cutting
      // this laptop off, and a bridge that keeps knocking every ten seconds is
      // the opposite of honouring that.
      this.running = false;
      throw new Error('Bu bilgisayarın erişimi kaldırılmış. Yeni bir API anahtarı girin.');
    }
    if (!res.ok) throw new Error(`Sunucu ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Sleep that a stop can cut short, and that leaves no timer behind. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      function finish() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/** What the operator picks from when they first plug a phone in. */
export async function discoverPhones(): Promise<{ ready: Awaited<ReturnType<typeof describeDevice>>[]; unauthorized: string[] }> {
  const { ready, unauthorized } = await listDevices();
  return {
    ready: await Promise.all(ready.map((s) => describeDevice(s))),
    unauthorized,
  };
}
