import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import {
  TelephonyProvider, TelephonyCapability, PrepareCallRequest, PreparedCall,
} from './telephony-provider.interface';
import { TelephonyProviderRegistry } from './telephony-provider.registry';
import { NetsantralClient } from './netsantral.client';

/**
 * NetGSM Netsantral (cloud PBX) provider: places the call server-side so it
 * originates from the tenant's 0850 trunk (api-dial), unlike the Lite provider's
 * click-to-dial tel: link. Stateless — SalesCallService passes the resolved
 * per-workspace config (creds + trunk + the rep's extension).
 */
@Injectable()
export class NetgsmApiAdapter implements TelephonyProvider, OnModuleInit {
  readonly id = 'netgsm-netsantral';
  readonly capabilities: readonly TelephonyCapability[] = ['api-dial', 'manual-log'];
  /** Per-rep extensions dial independently — not a single shared line. */
  readonly maxConcurrentCalls = 50;
  private readonly logger = new Logger(NetgsmApiAdapter.name);

  constructor(
    private readonly registry: TelephonyProviderRegistry,
    private readonly client: NetsantralClient,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async prepareOutboundCall(req: PrepareCallRequest): Promise<PreparedCall> {
    const c = req.config;
    if (!c?.username || !c?.password || !c?.trunk || !c?.internalNum) {
      throw new BadRequestException('Netsantral not configured (missing credentials, trunk, or rep extension).');
    }
    const outcome = await this.client.originate({
      username: c.username, password: c.password,
      customer_num: req.toPhone, internal_num: c.internalNum, trunk: c.trunk, pbxnum: c.pbxnum,
    });
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? `Netsantral rejected the call (code ${outcome.code ?? '?'}).`);
    }
    return { providerId: this.id, dialUri: '', mode: 'api', externalCallId: outcome.callId ?? null };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    return { ok: true, details: { mode: 'api-dial', provider: this.id } };
  }
}
