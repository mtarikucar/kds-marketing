import type { QueryClient } from '@tanstack/react-query';

/** Every capability list key starts with `capabilities`. */
export const CAPABILITIES_KEY = ['capabilities'] as const;
export const GROUPS_KEY = ['capability-groups'] as const;
export const BUDGET_ITEMS_KEY = ['budget', 'items'] as const;
export const CONNECTOR_HEALTH_KEY = ['connectors', 'health'] as const;
export const HOOKS_KEY = ['connectors', 'hooks'] as const;
/** Every phone query key starts with `devices`. */
export const DEVICES_KEY = ['devices'] as const;
/** A phone's command log. */
export const phoneLogKey = (capabilityId: string) => [...DEVICES_KEY, capabilityId, 'commands'] as const;
/** One phone command, with its result. */
export const deviceCommandKey = (commandId: string) => [...DEVICES_KEY, 'command', commandId] as const;
/**
 * How often the Devices tab reads the phones and their logs again: a device bridge's heartbeat
 * (`jt_device_protocol::HEARTBEAT_S`, 15 seconds), the most often what a card shows can change.
 */
export const PHONE_REFRESH_MS = 15_000;

/**
 * After a capability, group or connection change: the lists, the connectors' health, the pending
 * work (verify / connect / reconnect items) and the strategy (its channel and group gaps read the
 * capabilities).
 */
export async function invalidateCapabilities(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: CAPABILITIES_KEY }),
    queryClient.invalidateQueries({ queryKey: CONNECTOR_HEALTH_KEY }),
    queryClient.invalidateQueries({ queryKey: GROUPS_KEY }),
    queryClient.invalidateQueries({ queryKey: ['work', 'pending'] }),
    queryClient.invalidateQueries({ queryKey: ['strategy'] }),
  ]);
}
