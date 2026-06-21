import { BadRequestException } from '@nestjs/common';

/** Validate Netsantral config at save-time with actionable messages. */
export function assertNetsantralConfig(
  secrets: Record<string, string> | undefined,
  publicCfg: { trunk?: string } | undefined,
): void {
  const s = secrets ?? {};
  const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';
  if (!present('username')) {
    throw new BadRequestException('Netsantral requires a "username" (NetGSM abone no, e.g. 8508407303).');
  }
  if (!present('password')) {
    throw new BadRequestException('Netsantral requires a "password" (the API sub-user password).');
  }
  const trunk = (publicCfg?.trunk ?? '').replace(/[^\d]/g, '');
  if (trunk.length < 7) {
    throw new BadRequestException('Netsantral requires a numeric "trunk" (the 0850 outbound number).');
  }
}
