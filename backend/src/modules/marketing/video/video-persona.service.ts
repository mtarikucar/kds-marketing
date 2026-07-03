import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

export interface CreatePersonaInput {
  name: string;
  description?: string;
  referenceImageUrls?: string[];
  lockedSeed?: number;
  voiceId?: string;
}

/**
 * CRUD for reusable UGC personas (Faz 2). A persona is the identity anchor the
 * video pipeline threads into every shot for face/outfit consistency. Workspace-
 * scoped. Compliance (synthetic/consented likeness only) is enforced by the
 * Faz 3 compliance agent before generation, not here.
 */
@Injectable()
export class VideoPersonaService {
  constructor(private readonly prisma: PrismaService) {}

  async create(workspaceId: string, input: CreatePersonaInput) {
    if (!input.name?.trim()) throw new BadRequestException('name is required');
    return this.prisma.videoPersona.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        description: input.description,
        referenceImageUrls: (input.referenceImageUrls ?? []).slice(0, 9), // Seedance supports up to ~9 refs
        lockedSeed: input.lockedSeed,
        voiceId: input.voiceId,
      },
    });
  }

  list(workspaceId: string) {
    return this.prisma.videoPersona.findMany({ where: { workspaceId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
  }

  async get(workspaceId: string, id: string) {
    const p = await this.prisma.videoPersona.findFirst({ where: { id, workspaceId } });
    if (!p) throw new NotFoundException('Persona not found');
    return p;
  }
}
