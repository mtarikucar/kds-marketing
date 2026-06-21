/**
 * Telephony provider abstraction for the marketing sales line. Mirrors the
 * payments-core PaymentProvider pattern so swapping/adding a provider is a
 * registry entry, not a rewrite.
 *
 * Phase 2 ships a single click-to-dial adapter (NetgsmLiteAdapter): the rep's
 * softphone/handset places the call to a `tel:` URI and the outcome is logged
 * manually. The interface already carries the seams for a fuller provider
 * (api-dial, recording, status webhooks) so NetgsmApiAdapter can be added later
 * without touching SalesCallService.
 */
export type TelephonyCapability =
  | 'click-to-dial' // generates a tel:/softphone dial URI; rep dials manually
  | 'manual-log' // call outcome is logged manually by the rep
  | 'api-dial' // future: provider places the call via API
  | 'recording' // future: call recording (fills recordingUrl)
  | 'webhook'; // future: inbound status webhooks (fills callStatus)

export interface PrepareCallRequest {
  /** The number being called (customer/lead). */
  toPhone: string;
  /** The rep initiating the call. */
  marketingUserId: string;
  /**
   * Resolved provider config for api-dial providers (Netsantral). The Lite
   * (click-to-dial) provider ignores it. Supplied by SalesCallService after a
   * per-workspace lookup so adapters stay stateless/multi-tenant.
   */
  config?: {
    username: string;
    password: string;
    trunk: string;
    pbxnum?: string;
    /** The rep's extension; api-dial requires it. */
    internalNum: string;
  };
}

export interface PreparedCall {
  providerId: string;
  /** `tel:`/softphone dial URI for click-to-dial; a provider ref for api-dial. */
  dialUri: string;
  mode: 'click-to-dial' | 'api';
  /** Provider-side call id when the provider places the call (api-dial); null for click-to-dial. */
  externalCallId: string | null;
}

export interface TelephonyProvider {
  readonly id: string;
  readonly capabilities: readonly TelephonyCapability[];
  /**
   * Max simultaneously-active outbound calls the line supports. Netgsm Lite = 1
   * (a single shared company sales line). Enforced by SalesCallService.
   */
  readonly maxConcurrentCalls: number;
  prepareOutboundCall(req: PrepareCallRequest): Promise<PreparedCall>;
  healthCheck(): Promise<{ ok: boolean; details?: Record<string, unknown> }>;
}
