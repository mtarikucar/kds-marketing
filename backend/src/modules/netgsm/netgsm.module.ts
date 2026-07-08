import { Module } from '@nestjs/common';
import { NetsantralClient } from './santral/netsantral.client';
import { NetgsmCdrClient } from './santral/netgsm-cdr.client';

/**
 * NetGSM hub — owns ALL communication with NetGSM (SMS REST v2, İYS,
 * Netsantral PBX, voice, fax, balance, webhook receivers). Domain modules
 * (marketing channels/campaigns/telephony/compliance) keep the business
 * logic and consume these stateless clients via DI; per-workspace credential
 * resolution stays with the domain services that own the sealed stores.
 * Spec: docs/superpowers/specs/2026-07-08-netgsm-full-integration-design.md
 */
@Module({
  providers: [NetsantralClient, NetgsmCdrClient],
  exports: [NetsantralClient, NetgsmCdrClient],
})
export class NetgsmModule {}
