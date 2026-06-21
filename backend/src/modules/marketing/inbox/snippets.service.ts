import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateSnippetDto, UpdateSnippetDto } from '../dto/snippet.dto';

/**
 * Canned-response snippets (GoHighLevel parity). A snippet is either SHARED
 * (ownerId null — every agent sees it) or PRIVATE (ownerId = the author). The
 * `shortcut` is unique per workspace so `/shortcut` insertion is unambiguous.
 * Workspace-scoped: every multi-row/create call inlines workspaceId.
 */
@Injectable()
export class SnippetsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Snippets visible to this agent: all shared + their own private ones. */
  list(workspaceId: string, actorId: string) {
    return this.prisma.messageSnippet.findMany({
      where: { workspaceId, OR: [{ ownerId: null }, { ownerId: actorId }] },
      orderBy: { shortcut: 'asc' },
    });
  }

  async create(workspaceId: string, actorId: string, dto: CreateSnippetDto) {
    const dupe = await this.prisma.messageSnippet.findUnique({
      where: { workspaceId_shortcut: { workspaceId, shortcut: dto.shortcut } },
    });
    if (dupe) throw new ConflictException(`Shortcut "/${dto.shortcut}" already exists`);
    try {
      return await this.prisma.messageSnippet.create({
        data: {
          workspaceId,
          ownerId: dto.shared ? null : actorId,
          shortcut: dto.shortcut,
          title: dto.title,
          body: dto.body,
        },
      });
    } catch (e) {
      // The pre-check above is racy; the unique index is the real guard. Map a
      // concurrent-insert collision to the same friendly 409, not a 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Shortcut "/${dto.shortcut}" already exists`);
      }
      throw e;
    }
  }

  /** Owned = same workspace AND (mine OR shared). A private snippet of another
   *  agent is not editable. */
  private async getEditable(workspaceId: string, actorId: string, id: string) {
    const s = await this.prisma.messageSnippet.findFirst({ where: { id, workspaceId } });
    if (!s || (s.ownerId !== null && s.ownerId !== actorId)) {
      throw new NotFoundException('Snippet not found');
    }
    return s;
  }

  async update(workspaceId: string, actorId: string, id: string, dto: UpdateSnippetDto) {
    const s = await this.getEditable(workspaceId, actorId, id);
    return this.prisma.messageSnippet.update({
      where: { id: s.id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.shared !== undefined && { ownerId: dto.shared ? null : actorId }),
      },
    });
  }

  async remove(workspaceId: string, actorId: string, id: string) {
    const s = await this.getEditable(workspaceId, actorId, id);
    await this.prisma.messageSnippet.delete({ where: { id: s.id } });
    return { message: 'Snippet deleted' };
  }
}
