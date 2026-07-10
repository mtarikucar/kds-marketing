import { BadRequestException } from '@nestjs/common';

/**
 * Validate the secret credentials of a NetGSM SMS channel at save-time. NetGSM
 * requires the abone-no `usercode`, the API sub-user `password`, and an
 * İYS-approved sender `msgheader` of 3–11 characters. Failing here (with an
 * actionable message) beats discovering it as an opaque NetGSM error code on the
 * first real send.
 */
export function assertNetgsmSmsSecrets(secrets: Record<string, string> | undefined): void {
  const s = secrets ?? {};
  const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';

  if (!present('usercode')) {
    throw new BadRequestException('NetGSM SMS channel requires a "usercode" (NetGSM abone no).');
  }
  if (!present('password')) {
    throw new BadRequestException(
      'NetGSM SMS channel requires a "password" (the API sub-user password, not the panel login).',
    );
  }
  if (!present('msgheader')) {
    throw new BadRequestException(
      'NetGSM SMS channel requires a "msgheader" (the İYS-approved sender title).',
    );
  }
  const headerLen = s.msgheader.trim().length;
  if (headerLen < 3 || headerLen > 11) {
    throw new BadRequestException(
      `NetGSM "msgheader" must be 3–11 characters (got ${headerLen}).`,
    );
  }
}

/**
 * Validate the optional `useLegacySend` flag on a NetGSM SMS channel's PUBLIC
 * config (`Channel.configPublic`, decrypted straight through to
 * `ResolvedChannelConfig.public` by the registry — see
 * `channel-adapter.registry.ts#resolveConfig` — never the sealed secrets).
 * `NetgsmSmsAdapter.send` reads `config.public?.useLegacySend === true` to keep
 * using the legacy `/sms/send/get` GET API instead of the new REST v2 `send`
 * endpoint; every other value (absent, `false`) defaults to v2. This is
 * validation only — it never mutates or defaults the config, and never throws
 * when the key is simply absent (the "default false" lives in the adapter's
 * read, not here).
 */
export function assertNetgsmSmsPublicConfig(
  configPublic: Record<string, unknown> | undefined | null,
): void {
  if (configPublic == null) return;
  const flag = configPublic.useLegacySend;
  if (flag !== undefined && typeof flag !== 'boolean') {
    throw new BadRequestException('NetGSM SMS channel "useLegacySend" must be a boolean.');
  }
}
