import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  ConferenceProviderKind,
  HostConnection,
} from './conference-provider.interface';

/**
 * Resolve WHICH connected calendar account hosts a booking's video conference.
 *
 * The meeting organiser is whoever's OAuth token creates the event, so for a
 * ROUND_ROBIN calendar the conference must be hosted by the ASSIGNED member.
 * Resolution order:
 *   1. the booking's assignee's own enabled connection of the provider,
 *   2. the calendar owner's connection,
 *   3. the workspace's first enabled connection (back-compat single-account),
 *   4. null → the booking is created without a link (never a crash).
 *
 * Google Meet resolves against `google_calendar_connections`, Teams against
 * `outlook_calendar_connections`.
 */
@Injectable()
export class HostResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    workspaceId: string,
    booking: { calendarId: string; assigneeUserId?: string | null },
    kind: ConferenceProviderKind,
  ): Promise<HostConnection | null> {
    const table: any =
      kind === 'GOOGLE_MEET'
        ? this.prisma.googleCalendarConnection
        : this.prisma.outlookCalendarConnection;

    const byUser = (marketingUserId: string) =>
      table.findFirst({
        where: { workspaceId, marketingUserId, enabled: true },
        orderBy: { createdAt: 'asc' },
      });

    let row = booking.assigneeUserId
      ? await byUser(booking.assigneeUserId)
      : null;

    if (!row) {
      const cal = await this.prisma.bookingCalendar.findFirst({
        where: { id: booking.calendarId, workspaceId },
        select: { ownerUserId: true },
      });
      if (cal?.ownerUserId) row = await byUser(cal.ownerUserId);
    }

    if (!row) {
      row = await table.findFirst({
        where: { workspaceId, enabled: true },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (!row) return null;
    return { kind, connectionId: row.id, marketingUserId: row.marketingUserId };
  }
}
