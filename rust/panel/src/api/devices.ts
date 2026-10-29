import { request, seg } from './client';
import type { Actor, Rfc3339, Uuid } from './types';

// The workspace's phones (`/api/devices`, spec `2026-10-28-device-bridge-design.md` §5.4): a
// phone's log and one command, for a person holding `devices.work`. A command carries what was
// typed and the shell arguments, and a result what the screen showed: shown to who may see the
// card (every command is logged, owner), never written to the console.

/** `jt_devices::CommandStatus`: `queued` and `leased` are not done yet. */
export type CommandStatus = 'queued' | 'leased' | 'done' | 'failed' | 'expired' | 'canceled';
export const COMMAND_STATUSES: readonly CommandStatus[] = [
  'queued',
  'leased',
  'done',
  'failed',
  'expired',
  'canceled',
];

/** `jt_devices::FailReason`: why a `failed` command failed; `unknown` for a newer bridge's. */
export type FailReason =
  | 'device_offline'
  | 'element_not_found'
  | 'unicode_unsupported'
  | 'unsupported_on_platform'
  | 'unsupported_by_bridge'
  | 'adb_error'
  | 'screen_busy'
  | 'timeout'
  | 'bridge_error'
  | 'file_not_found'
  | 'unknown';

/** `jt_devices::DeviceKey`. */
export type DeviceKey =
  | 'back'
  | 'home'
  | 'enter'
  | 'app_switch'
  | 'delete'
  | 'volume_up'
  | 'volume_down'
  | 'power';

/**
 * `jt_devices::DeviceCommand`, tagged by `kind`. A `tap_on` names exactly one of `text`, `id`
 * and `desc`.
 */
export type DeviceCommand =
  | { kind: 'observe'; screenshot: boolean }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'tap_on'; text?: string; id?: string; desc?: string; exact: boolean }
  | { kind: 'long_press'; x: number; y: number; ms: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { kind: 'text'; value: string }
  | { kind: 'key'; key: DeviceKey }
  | { kind: 'open_url'; url: string }
  | { kind: 'launch_app'; app_id: string }
  | { kind: 'shell'; argv: string[] }
  | { kind: 'push_file'; file_id: Uuid; dest: string }
  | { kind: 'pull_file'; path: string }
  | { kind: 'screenshot' };
export type CommandKind = DeviceCommand['kind'];

/**
 * `jt_app::usecases::devices::agent::LoggedCommand`: a command as a phone's log shows it, with
 * its arguments, without its result.
 */
export interface LoggedCommand {
  command_id: Uuid;
  /** The phone. */
  capability_id: Uuid;
  kind: CommandKind;
  command: DeviceCommand;
  status: CommandStatus;
  /** How many times a bridge was handed it. */
  attempts: number;
  reason: FailReason | null;
  detail: string | null;
  requested_by: Actor;
  created_at: Rfc3339;
  expires_at: Rfc3339;
  leased_at: Rfc3339 | null;
  done_at: Rfc3339 | null;
}

/** `jt_app::usecases::devices::agent::CommandOut`: one command, with its result. */
export interface CommandOut extends LoggedCommand {
  /**
   * What a `done` command produced, as its bridge reported it (`kind`: `observation`, `done`,
   * `shell` or `file`).
   */
  result: Record<string, unknown> | null;
  /** An address the file the result names is read from, for ten minutes. */
  file_url: string | null;
}

/**
 * `GET /api/devices/{capability_id}/commands`: the phone's most recent commands, newest first;
 * `limit` 1 to 200 (50 when left out).
 */
export function phoneCommands(capabilityId: string, query: { limit?: number } = {}): Promise<LoggedCommand[]> {
  return request('GET', `/api/devices/${seg(capabilityId)}/commands`, { query: { limit: query.limit } });
}

/**
 * `GET /api/devices/commands/{command_id}`: one command with its result. `wait_s: 0` answers at
 * once; without it the server waits up to 20 seconds for a command still running to end.
 */
export function getCommand(commandId: string, query: { wait_s?: number } = {}): Promise<CommandOut> {
  return request('GET', `/api/devices/commands/${seg(commandId)}`, { query: { wait_s: query.wait_s } });
}
