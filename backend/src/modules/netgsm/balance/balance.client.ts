import { Injectable, Logger } from '@nestjs/common';
import { NetgsmRestClient } from '../core/netgsm-rest.client';
import { netgsmErrorMessage } from '../core/netgsm-error.map';

export interface BalanceResult {
  ok: boolean;
  /** true = NetGSM authenticated the creds (even if no package, code 60);
   *  false = rejected (code 30); null = couldn't reach NetGSM. */
  credsValid: boolean | null;
  code: string | null;
  credit: string | null;
  packages: Array<{ name: string; remaining: string | null }>;
  message: string | null;
}

/**
 * POST /balance — package + TL credit readout, and the cheapest LIVE
 * credential probe NetGSM offers (unlike /netsantral/report it is not
 * IP-allow-listed, so "Verify" works from anywhere). stip=3 asks for both
 * package list and TL credit; the response shape varies by account type, so
 * parsing is tolerant: array of {balance_name|paket, amount|miktar} rows,
 * or {code} error envelope, or a bare-code text body.
 */
@Injectable()
export class BalanceClient {
  private readonly logger = new Logger(BalanceClient.name);

  constructor(private readonly rest: NetgsmRestClient) {}

  async fetchBalance(creds: { usercode: string; password: string }): Promise<BalanceResult> {
    let httpStatus: number, body: any, rawText: string;
    try {
      ({ httpStatus, body, rawText } = await this.rest.request({
        path: '/balance', method: 'POST', creds, body: { stip: 3 },
      }));
    } catch (e: any) {
      return { ok: false, credsValid: null, code: null, credit: null, packages: [], message: e?.message ?? 'NetGSM erişilemedi' };
    }
    const code = typeof body?.code === 'string' ? body.code : /^\d{2,3}$/.test(rawText) ? rawText : null;
    if (code && code !== '00') {
      return {
        ok: false,
        credsValid: code === '30' ? false : code === '60' ? true : null,
        code, credit: null, packages: [], message: netgsmErrorMessage(code),
      };
    }
    const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.balance) ? body.balance : [];
    const packages = rows.map((r) => ({
      name: String(r?.balance_name ?? r?.paket ?? r?.name ?? 'paket'),
      remaining: r?.amount != null ? String(r.amount) : r?.miktar != null ? String(r.miktar) : null,
    }));
    const tl = packages.find((p) => /tl|kredi|bakiye/i.test(p.name));
    return {
      ok: httpStatus === 200 && (packages.length > 0 || body != null),
      credsValid: true, code: null,
      credit: tl?.remaining ?? null, packages,
      message: null,
    };
  }
}
