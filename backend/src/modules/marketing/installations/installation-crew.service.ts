import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCrewDto, UpdateCrewDto } from './dto/installation-crew.dto';
import { toUtcDateOnly } from './installation.util';

/** Active statuses that occupy a crew slot on a given day. */
const OCCUPYING_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];

@Injectable()
export class InstallationCrewService {
  constructor(private readonly prisma: PrismaService) {}

  create(workspaceId: string, dto: CreateCrewDto) {
    return this.prisma.installationCrew.create({
      data: {
        workspaceId,
        name: dto.name,
        dailyCapacity: dto.dailyCapacity ?? 1,
        notes: dto.notes ?? null,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateCrewDto) {
    await this.getOrThrow(workspaceId, id);
    return this.prisma.installationCrew.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.dailyCapacity !== undefined ? { dailyCapacity: dto.dailyCapacity } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  list(workspaceId: string, activeOnly = false) {
    return this.prisma.installationCrew.findMany({
      where: { workspaceId, ...(activeOnly ? { active: true } : {}) },
      orderBy: { name: 'asc' },
    });
  }

  async getOrThrow(workspaceId: string, id: string) {
    const crew = await this.prisma.installationCrew.findFirst({
      where: { id, workspaceId },
    });
    if (!crew) throw new NotFoundException('Crew not found');
    return crew;
  }

  /**
   * Crews with their booked-job count on a date + an availability flag
   * (booked < dailyCapacity). The scheduling overlap check used by
   * InstallationJobService.schedule mirrors this per-crew.
   */
  async availabilityOn(workspaceId: string, dateInput: string | Date) {
    // Canonicalize to the same date-only UTC key the scheduler writes, so the
    // availability view and InstallationJobService.schedule agree on the day.
    const date = toUtcDateOnly(dateInput);
    const crews = await this.prisma.installationCrew.findMany({
      where: { workspaceId, active: true },
      orderBy: { name: 'asc' },
    });
    const counts = await this.prisma.installationJob.groupBy({
      by: ['crewId'],
      where: {
        workspaceId,
        scheduledDate: date,
        status: { in: OCCUPYING_STATUSES },
        crewId: { not: null },
      },
      _count: true,
    });
    const byCrew = new Map(counts.map((c) => [c.crewId, c._count]));
    return crews.map((crew) => {
      const booked = byCrew.get(crew.id) ?? 0;
      return { crew, booked, available: booked < crew.dailyCapacity };
    });
  }
}
