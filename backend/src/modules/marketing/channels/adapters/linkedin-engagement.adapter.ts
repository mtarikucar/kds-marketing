import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import {
  ChannelAdapter,
  ChannelCapability,
  OutboundSend,
  ResolvedChannelConfig,
  SendResult,
} from '../channel-adapter.interface';
import { linkedinRest } from '../../../../common/util/linkedin-api.util';

const CAPS: readonly ChannelCapability[] = ['send', 'receive'];

/**
 * LinkedIn engagement adapter — the DM substitute. LinkedIn exposes NO general
 * DM API, so "send" here means REPLY to a comment on one of the workspace's OWN
 * organization posts (POST /rest/socialActions/{postUrn}/comments). The poller
 * (linkedin-engagement-poll.service) provides the inbound half. Secrets:
 * { accessToken }. The channel's `externalId` is the actor urn that authors the
 * reply (urn:li:organization:{id} or urn:li:person:{id}).
 *
 * CAPABILITY GATE: fully inert until `config.public.linkedinEngagement ===
 * 'granted'` (set once LinkedIn Community Management access is approved). Until
 * then send() returns FAILED WITHOUT any HTTP — nothing leaks to LinkedIn.
 */
@Injectable()
export class LinkedinEngagementAdapter implements ChannelAdapter, OnModuleInit {
  readonly type = 'LINKEDIN' as const;
  readonly capabilities = CAPS;
  private readonly logger = new Logger(LinkedinEngagementAdapter.name);

  constructor(private readonly registry: ChannelAdapterRegistry) {}
  onModuleInit(): void {
    this.registry.register(this);
  }

  async send({ config, to, text }: OutboundSend): Promise<SendResult> {
    // Capability gate — dormant until Community Management is approved. Graceful
    // and inert: no token use, no HTTP, just a FAILED result the sender records.
    if (config.public?.linkedinEngagement !== 'granted') {
      return { externalMessageId: null, status: 'FAILED', error: 'LinkedIn engagement access not granted' };
    }
    const token = config.secrets.accessToken;
    if (!token) {
      return { externalMessageId: null, status: 'FAILED', error: 'LinkedIn access token missing' };
    }
    // The post we're commenting on: the conversation passes the post urn as `to`;
    // fall back to a channel-pinned post urn for single-post setups.
    const postUrn = (to && to.trim()) || String(config.public?.postUrn ?? '');
    if (!postUrn) {
      return { externalMessageId: null, status: 'FAILED', error: 'LinkedIn post urn missing (no `to` and no config.public.postUrn)' };
    }
    const res = await linkedinRest(
      `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
      {
        accessToken: token,
        method: 'POST',
        body: {
          actor: config.externalId,
          object: postUrn,
          message: { text },
        },
      },
    );
    if (!res.ok) {
      return {
        externalMessageId: null,
        status: 'FAILED',
        error: `LinkedIn ${res.status}: ${String(res.error?.message ?? '').slice(0, 300)}`,
      };
    }
    // The created comment id is returned in the x-restli-id header (result.restliId).
    return { externalMessageId: res.restliId, status: 'SENT' };
  }

  async healthCheck(config: ResolvedChannelConfig) {
    const ok = !!config.secrets.accessToken && !!config.externalId;
    return {
      ok,
      details: {
        hasToken: !!config.secrets.accessToken,
        hasActorUrn: !!config.externalId,
        engagementGranted: config.public?.linkedinEngagement === 'granted',
      },
    };
  }
}
