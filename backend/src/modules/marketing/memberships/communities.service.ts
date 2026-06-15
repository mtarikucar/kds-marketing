import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

interface CommunityInput {
  name: string;
  description?: string;
}
interface PostInput {
  title?: string;
  body: string;
}

/**
 * Epic C3 — community spaces with members, posts and comments. Members are
 * Leads; posts/comments are authored here by staff users (member-authored
 * content arrives via the future member portal). Workspace-scoped throughout.
 */
@Injectable()
export class CommunitiesService {
  constructor(private prisma: PrismaService) {}

  private slugify(s: string): string {
    return (
      s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) ||
      'community'
    );
  }

  list(workspaceId: string) {
    return this.prisma.community.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(workspaceId: string, dto: CommunityInput) {
    const slug = this.slugify(dto.name);
    const dupe = await this.prisma.community.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
    if (dupe) throw new ConflictException(`Community slug "${slug}" already exists`);
    return this.prisma.community.create({
      data: { workspaceId, name: dto.name, slug, description: dto.description },
    });
  }

  private async assertCommunity(workspaceId: string, id: string) {
    const c = await this.prisma.community.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Community not found');
    return c;
  }

  async get(workspaceId: string, id: string) {
    await this.assertCommunity(workspaceId, id);
    return this.prisma.community.findFirst({
      where: { id, workspaceId },
      include: { _count: { select: { members: true, posts: true } } },
    });
  }

  async update(workspaceId: string, id: string, dto: Partial<CommunityInput> & { status?: string }) {
    await this.assertCommunity(workspaceId, id);
    return this.prisma.community.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.assertCommunity(workspaceId, id);
    await this.prisma.community.delete({ where: { id } });
    return { id };
  }

  // ---- members ----------------------------------------------------------

  async join(workspaceId: string, communityId: string, leadId: string, role = 'MEMBER') {
    await this.assertCommunity(workspaceId, communityId);
    return this.prisma.communityMember.upsert({
      where: { communityId_leadId: { communityId, leadId } },
      create: { communityId, leadId, role },
      update: { role },
    });
  }

  async leave(workspaceId: string, communityId: string, leadId: string) {
    await this.assertCommunity(workspaceId, communityId);
    const res = await this.prisma.communityMember.deleteMany({
      where: { communityId, leadId },
    });
    return { removed: res.count };
  }

  async members(workspaceId: string, communityId: string) {
    await this.assertCommunity(workspaceId, communityId);
    return this.prisma.communityMember.findMany({
      where: { communityId },
      orderBy: { joinedAt: 'asc' },
    });
  }

  // ---- posts + comments -------------------------------------------------

  async createPost(workspaceId: string, communityId: string, dto: PostInput, authorUserId: string) {
    await this.assertCommunity(workspaceId, communityId);
    return this.prisma.communityPost.create({
      data: { communityId, workspaceId, authorUserId, title: dto.title, body: dto.body },
    });
  }

  async listPosts(workspaceId: string, communityId: string, page = 1, pageSize = 20) {
    await this.assertCommunity(workspaceId, communityId);
    return this.prisma.communityPost.findMany({
      where: { communityId, workspaceId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { comments: true } } },
    });
  }

  private async assertPost(workspaceId: string, postId: string) {
    const p = await this.prisma.communityPost.findFirst({
      where: { id: postId, workspaceId },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Post not found');
    return p;
  }

  async pinPost(workspaceId: string, postId: string, pinned: boolean) {
    await this.assertPost(workspaceId, postId);
    return this.prisma.communityPost.update({ where: { id: postId }, data: { pinned } });
  }

  async removePost(workspaceId: string, postId: string) {
    await this.assertPost(workspaceId, postId);
    await this.prisma.communityPost.delete({ where: { id: postId } });
    return { id: postId };
  }

  async addComment(workspaceId: string, postId: string, body: string, authorUserId: string) {
    await this.assertPost(workspaceId, postId);
    return this.prisma.communityComment.create({
      data: { postId, workspaceId, authorUserId, body },
    });
  }

  async listComments(workspaceId: string, postId: string) {
    await this.assertPost(workspaceId, postId);
    return this.prisma.communityComment.findMany({
      where: { postId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
