import { Injectable } from '@nestjs/common';

/**
 * Per-ACCOUNT (usercode) sliding-window budgets for NetGSM's per-account rate
 * limits (report 60/min, İYS 10/min, autocall 10/min, statistics 2/min, ...).
 * Replaces global per-tick caps that starved multi-tenant polling. In-memory
 * per instance — the same accepted limitation as the entitlements cache; the
 * limits are safety margins, not exact accounting.
 */
@Injectable()
export class AccountRateBudgeter {
  private readonly windows = new Map<string, number[]>();

  /** True and consumes one slot when under `limit` calls in the trailing `perMs` window. */
  tryTake(usercode: string, bucket: string, limit: number, perMs: number): boolean {
    const key = `${usercode}:${bucket}`;
    const now = Date.now();
    const stamps = (this.windows.get(key) ?? []).filter((t) => now - t < perMs);
    if (stamps.length >= limit) {
      this.windows.set(key, stamps);
      return false;
    }
    stamps.push(now);
    this.windows.set(key, stamps);
    return true;
  }
}
