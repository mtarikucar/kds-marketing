import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GeneratedAssetType } from './media-asset.constants';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  MEDIA_MODELS,
  MediaModel,
  assertCataloguedModel,
  assertModelOffersAspect,
  defaultModelFor,
  isCataloguedModel,
  resolveMediaModelId,
} from './media-models.config';
import { DEFAULT_SHOT_ASPECT } from '../../video/video-pipeline.service';

/** What a settings card needs to render one row: the model, and what it costs. */
export interface PricedMediaModel extends MediaModel {
  /** True for the model the platform falls back to when this workspace has
   *  chosen nothing — so "no choice" can be shown as a real option rather than
   *  an empty select. */
  isPlatformDefault: boolean;
}

export interface MediaModelDefaults {
  /** The workspace's CHOICE, verbatim — including one the catalogue has since
   *  dropped. `null` means it has not made one. Reported unchanged rather than
   *  scrubbed: a manager who chose a model and finds the card silently back on
   *  "Platform default" has been told their choice never happened. The one
   *  translation applied: an id fal has RETIRED is reported as its successor,
   *  because that is the model the choice now runs on (see `replacedBy`). */
  defaultImageModel: string | null;
  defaultVideoModel: string | null;
  /** What would actually run today — the choice, or the platform constant. */
  effectiveImageModel: string;
  effectiveVideoModel: string;
  /**
   * The stored choice this workspace can no longer run, when there is one.
   *
   * `null` in the normal case (no choice, or a choice the catalogue still
   * knows). Non-null means the two pairs above DISAGREE, and the card has to
   * say which one wins — otherwise it renders a RadioGroup whose value matches
   * no option, badges nothing "In use", and never states what the next video
   * will actually be billed at.
   */
  retiredImageModel: string | null;
  retiredVideoModel: string | null;
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
    // The message lives in the catalogue, not here: the campaign override
    // (`SocialCampaignsService`) enforces the same rule at its own write, and
    // the two doors must not tell a manager two different things about the same
    // five options.
    assertCataloguedModel(id, type);
    // The frame, at the same door and for the same reason. A workspace default
    // that cannot shoot 9:16 is a choice that fails every content concept
    // planned under it — and that failure used to surface inside the producer,
    // after a human had approved the work, where nothing could act on it. Here
    // it is one sentence, on the card where the model is being picked, naming
    // the ratios the model does publish. A model that takes no ratio at all is
    // allowed: see `assertModelOffersAspect`.
    if (type === 'VIDEO') assertModelOffersAspect(id, DEFAULT_SHOT_ASPECT);
    return id;
  }

  /**
   * The read model, with the catalogue re-checked at READ time.
   *
   * `validated()` gates the write, so a stored id was catalogued the day it was
   * chosen. That is not the same as being catalogued TODAY: the catalogue is a
   * TypeScript constant, and a deploy that retires a model leaves the old id in
   * every workspace that picked it. `MediaGenService` already handles this —
   * an uncatalogued stored default is ignored and the platform constant runs,
   * with a log line — so nothing generates on an unpriced model.
   *
   * The screen was the part that lied. Returning the stored id as
   * `effectiveVideoModel` made the card render a RadioGroup whose value matched
   * no option, so no row carried the "In use" badge and the one screen whose
   * entire purpose is to stop the spending decision being blind stopped saying
   * what the next video would cost. The fallback is therefore applied here too,
   * and REPORTED — the retired id travels beside it so the card can name the
   * choice that is no longer honoured instead of quietly dropping it.
   */
  private project(imageStored: string | null, videoStored: string | null): MediaModelDefaults {
    // A choice fal has retired is honoured under its successor's id — and
    // reported as that id, so the card selects the row that actually runs
    // rather than one it no longer lists.
    const image = imageStored === null ? null : resolveMediaModelId(imageStored);
    const video = videoStored === null ? null : resolveMediaModelId(videoStored);
    const platform = new Set([defaultModelFor('IMAGE'), defaultModelFor('VIDEO')]);
    const imageLive = image !== null && isCataloguedModel(image, 'IMAGE');
    const videoLive = video !== null && isCataloguedModel(video, 'VIDEO');
    return {
      defaultImageModel: image,
      defaultVideoModel: video,
      effectiveImageModel: imageLive ? (image as string) : defaultModelFor('IMAGE'),
      effectiveVideoModel: videoLive ? (video as string) : defaultModelFor('VIDEO'),
      retiredImageModel: image !== null && !imageLive ? image : null,
      retiredVideoModel: video !== null && !videoLive ? video : null,
      models: Object.values(MEDIA_MODELS)
        .filter((m) => !m.replacedBy)
        .map((m) => ({ ...m, isPlatformDefault: platform.has(m.id) })),
    };
  }
}
