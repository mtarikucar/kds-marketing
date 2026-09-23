import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { PlatformGuard } from '../guards/platform.guard';
import { MailAdminService } from '../services/mail-admin.service';

/**
 * The platform console's E-posta panel.
 *
 * One shared relay carries the fallback mail of every tenant that has not
 * connected its own mailbox, so when it throttles the damage is collective and
 * the operator's first question is "whose blast caused this". `overview()`
 * answers it — today's platform-transport count per tenant against both
 * ceilings, busiest first — and `setPaused` is the switch that stops the one
 * tenant without taking the relay down for everybody else.
 *
 * Platform-guarded: it aggregates across tenants and must never be reachable
 * with a workspace key.
 */
@Controller('platform/mail')
@UseGuards(PlatformGuard)
export class MailAdminController {
  constructor(private readonly mail: MailAdminService) {}

  /** Every workspace's mail day, plus the env-gated features this deployment
   *  leaves inert. Never throws on a partial read — a console that 500s during
   *  an outage is unavailable exactly when it matters. */
  @Get('overview')
  overview() {
    return this.mail.overview();
  }

  /** Stop (or resume) one tenant's sending. `paused` is read strictly: a
   *  missing or malformed body resumes rather than pausing by accident. */
  @Patch('workspaces/:id/pause')
  setPaused(@Param('id') id: string, @Body() dto: { paused?: boolean }) {
    return this.mail.setPaused(id, dto?.paused === true);
  }
}
