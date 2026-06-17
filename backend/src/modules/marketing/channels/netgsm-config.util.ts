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
