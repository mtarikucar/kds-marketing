import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import {
  ChannelAdapter,
  ChannelType,
  ResolvedChannelConfig,
} from './channel-adapter.interface';

/** The minimal Channel-row shape the registry needs to resolve a config. */
export interface ChannelRowLike {
  id: string;
  workspaceId: string;
  type: string;
  externalId: string | null;
  configSealed: string | null;
  configPublic: unknown;
}

/**
 * Registry of installed ChannelAdapters (one per ChannelType). Adapters
 * self-register at module init (mirrors TelephonyProviderRegistry). The
 * registry — NOT the adapters — owns secret decryption: `resolveConfig` opens
 * the AES-256-GCM sealed blob so an adapter only ever sees plaintext creds it
 * received as an argument, never the DB row.
 */
@Injectable()
export class ChannelAdapterRegistry {
  private readonly logger = new Logger(ChannelAdapterRegistry.name);
  private readonly adapters = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.type)) {
      this.logger.warn(`ChannelAdapter ${adapter.type} re-registered`);
    }
    this.adapters.set(adapter.type, adapter);
    this.logger.log(
      `Registered ChannelAdapter: ${adapter.type} (caps=${adapter.capabilities.join(',')})`,
    );
  }

  has(type: string): boolean {
    return this.adapters.has(type as ChannelType);
  }

  get(type: string): ChannelAdapter {
    const a = this.adapters.get(type as ChannelType);
    if (!a) throw new NotFoundException(`Unknown channel type: ${type}`);
    return a;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Decrypt a Channel row into a ResolvedChannelConfig. The sealed blob is the
   * AES-256-GCM ciphertext of `JSON.stringify(secrets)`; a malformed/locked box
   * yields empty secrets (the adapter then fails its own healthCheck) rather
   * than throwing here and taking the whole request down.
   */
  resolveConfig(channel: ChannelRowLike): ResolvedChannelConfig {
    let secrets: Record<string, string> = {};
    if (channel.configSealed) {
      try {
        const json = openSecret(channel.configSealed);
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') {
          secrets = parsed as Record<string, string>;
        }
      } catch (e: any) {
        this.logger.error(
          `channel ${channel.id} config decrypt failed: ${e?.message ?? e}`,
        );
      }
    }
    const pub =
      channel.configPublic && typeof channel.configPublic === 'object'
        ? (channel.configPublic as Record<string, unknown>)
        : {};
    return {
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      type: channel.type as ChannelType,
      externalId: channel.externalId,
      secrets,
      public: pub,
    };
  }
}
