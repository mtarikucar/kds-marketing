import { Injectable, NotFoundException } from '@nestjs/common';
import { BUSINESS_TYPE_PATTERN } from '../dto/create-lead.dto';
import { PrismaService } from '../../../prisma/prisma.service';

export interface WorkspaceBusinessTypes {
  businessTypes: string[];
  historicalBusinessTypes?: string[];
}

@Injectable()
export class WorkspaceBusinessTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<WorkspaceBusinessTypes> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    const settings = workspace.settings;
    const stored =
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings.businessTypes
        : undefined;
    // Normalize the response only; valid legacy keys and stored data stay intact.
    const businessTypes = this.validKeys(stored);
    const historical = await this.prisma.lead.groupBy({
      where: { workspaceId },
      by: ['businessType'],
    });
    const historicalBusinessTypes = this.validKeys(historical.map((lead) => lead.businessType));
    return {
      businessTypes: businessTypes.length ? businessTypes : ['OTHER'],
      ...(historicalBusinessTypes.length ? { historicalBusinessTypes } : {}),
    };
  }

  private validKeys(values: unknown): string[] {
    return Array.isArray(values)
      ? [...new Set(values.filter((value): value is string =>
          typeof value === 'string' && BUSINESS_TYPE_PATTERN.test(value),
        ))]
      : [];
  }

  async set(
    workspaceId: string,
    businessTypes: string[],
  ): Promise<WorkspaceBusinessTypes> {
    // Change only this JSON key under the row lock; never overwrite a stale
    // snapshot of settings or rewrite historical lead business types.
    const rows = await this.prisma.$queryRaw<WorkspaceBusinessTypes[]>`
      UPDATE "workspaces"
      SET "settings" = jsonb_set(
        CASE WHEN jsonb_typeof("settings") = 'object' THEN "settings" ELSE '{}'::jsonb END,
        '{businessTypes}', ${JSON.stringify(businessTypes)}::jsonb, true
      ), "updatedAt" = NOW()
      WHERE "id" = ${workspaceId}
      RETURNING "settings"->'businessTypes' AS "businessTypes"
    `;
    if (!rows.length) throw new NotFoundException('Workspace not found');
    return rows[0];
  }
}
