import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GeneratedAssetType } from './media-asset.constants';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  MEDIA_MODELS,
  MediaModel,
  defaultModelFor,
  isCataloguedModel,
} from './media-models.config';

/** What a settings card needs to render one row: the model, and what it costs. */
export interface PricedMediaModel extends MediaModel {
  /** True for the model the platform falls back to when this workspace has
   *  chosen nothing — so "no choice" can be shown as a real option rather than
   *  an empty select. */
  isPlatformDefault: boolean;
}

export interface MediaModelDefaults {
  /** The workspace's CHOICE. `null` means it has not made one. */
  defaultImageModel: string | null;
  defaultVideoModel: string | null;
  /** What would actually run today — the choice, or the platform constant. */
  effectiveImageModel: string;
  effectiveVideoModel: string;
  models: PricedMediaModel[];
}

export interface SetMediaModelDefaults {
  /** Absent = leave alone. `null` = clear the choice, back to the platform
   *  default. A catalogued id of the matching kind = choose it. */
  defaultImageModel?: string | null;
  defaultVideoModel?: string | null;
}

/**
 * İçerik üretim hattı, aşama 3 — the workspace-level model default, read and
 * written.
 *
 * The resolution order is `campaign override ?? workspace default ?? code
 * constant` and it is APPLIED in `MediaGenService.requestGeneration`; this
 * service owns the middle term's storage and its validation, and it serves the
 * priced catalogue the settings card renders.
 *
 * Why the catalogue is served rather than duplicated on the client: the client
 * already carries one hand-maintained copy of the model list
 * (`AiStudioPage.tsx`), it has already drifted from the backend labels, and it
 * shows no price at all. Video is the most expensive action in this product and
 * choosing a model IS the cost decision — a picker that hides the number is the
 * wrong picker, and a second place to forget to update it is how the number
 * goes stale.
 */
@Injectable()
export class MediaModelDefaultsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<MediaModelDefaults> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { defaultImageModel: true, defaultVideoModel: true },
    });
    // Not "answer with the platform defaults". A missing workspace is a broken
    // caller, and pretending it has settings would let a bad id look like a
    // configured tenant that simply chose nothing.
    if (!ws) throw new NotFoundException('Workspace not found');
    return this.project(ws.defaultImageModel, ws.defaultVideoModel);
  }

  async set(workspaceId: string, patch: SetMediaModelDefaults): Promise<MediaModelDefaults> {
    const data: { defaultImageModel?: string | null; defaultVideoModel?: string | null } = {};
    if (patch.defaultImageModel !== undefined) {
      data.defaultImageModel = this.validated(patch.defaultImageModel, 'IMAGE');
    }
    if (patch.defaultVideoModel !== undefined) {
      data.defaultVideoModel = this.validated(patch.defaultVideoModel, 'VIDEO');
    }
    if (!Object.keys(data).length) {
      throw new BadRequestException(
        'Name at least one of defaultImageModel or defaultVideoModel. Send null to clear a choice back to the platform default.',
      );
    }

    const ws = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data,
      select: { defaultImageModel: true, defaultVideoModel: true },
    });
    return this.project(ws.defaultImageModel, ws.defaultVideoModel);
  }

  /**
   * The same rule `MediaGenService` applies to an explicit model, applied at the
   * WRITE. Without it the settings screen would happily store a value the read
   * path then refuses — the workspace believes it chose a model and silently
   * generates on the platform constant instead, at a different price than the
   * card shows.
   */
  private validated(value: string | null, type: GeneratedAssetType): string | null {
    if (value === null) return null;
    const id = String(value).trim();
    if (!id) return null;
    if (!isCataloguedModel(id, type)) {
      const options = Object.values(MEDIA_MODELS)
        .filter((m) => m.type === type)
        .map((m) => m.id)
        .join(', ');
      throw new BadRequestException(
        `"${id}" is not a catalogued ${type.toLowerCase()} model, so its price is unknown and it cannot be run. Choose one of: ${options}.`,
      );
    }
    return id;
  }

  private project(image: string | null, video: string | null): MediaModelDefaults {
    const platform = new Set([defaultModelFor('IMAGE'), defaultModelFor('VIDEO')]);
    return {
      defaultImageModel: image,
      defaultVideoModel: video,
      effectiveImageModel: image ?? defaultModelFor('IMAGE'),
      effectiveVideoModel: video ?? defaultModelFor('VIDEO'),
      models: Object.values(MEDIA_MODELS).map((m) => ({ ...m, isPlatformDefault: platform.has(m.id) })),
    };
  }
}
