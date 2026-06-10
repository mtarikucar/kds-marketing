import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCrewDto, UpdateCrewDto } from './dto/installation-crew.dto';
import { toUtcDateOnly } from './installation.util';

/** Active statuses that occupy a crew slot on a given day. */
const OCCUPYING_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];

@Injectable()
export class InstallationCrewService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateCrewDto) {
    return this.prisma.installationCrew.create({
      data: {
        name: dto.name,
        dailyCapacity: dto.dailyCapacity ?? 1,
        notes: dto.notes ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateCrewDto) {
    await this.getOrThrow(id);
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

  list(activeOnly = false) {
    return this.prisma.installationCrew.findMany({
      where: activeOnly ? { active: true } : {},
      orderBy: { name: 'asc' },
    });
  }

  getOrThrow(id: string) {
    return this.prisma.installationCrew.findUniqueOrThrow({ where: { id } }).catch(() => {
      throw new NotFoundException('Crew not found');
    });
  }

  /**
   * Crews with their booked-job count on a date + an availability flag
   * (booked < dailyCapacity). The scheduling overlap check used by
   * InstallationJobService.schedule mirrors this per-crew.
   */
  async availabilityOn(dateInput: string | Date) {
    // Canonicalize to the same date-only UTC key the scheduler writes, so the
    // availability view and InstallationJobService.schedule agree on the day.
    const date = toUtcDateOnly(dateInput);
    const crews = await this.prisma.installationCrew.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    const counts = await this.prisma.installationJob.groupBy({
      by: ['crewId'],
      where: {
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
