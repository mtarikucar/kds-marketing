import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface OnboardingState {
  /** True once the workspace has put the setup guide away. */
  dismissed: boolean;
}

/**
 * Whether the first-run setup guide has been dismissed, per WORKSPACE.
 *
 * This lived only in the browser (`localStorage['kds-onboarding']`), which made
 * it a per-device opinion rather than a workspace fact: dismiss it on a laptop
 * and it is still waiting on a phone; clear site data and a fully configured
 * workspace is nagged again; and a second team member sees a guide the owner
 * already worked through.
 *
 * Stored inside `Workspace.settings` — the schema's free-shape Jsonb bag,
 * explicitly there "so additions don't need migrations" — under an `onboarding`
 * key, so this needs no schema change. Reads and writes are narrow: everything
 * else in the bag is preserved on write.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string): Promise<OnboardingState> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    return { dismissed: this.readDismissed(ws?.settings) };
  }

  async setDismissed(workspaceId: string, dismissed: boolean): Promise<OnboardingState> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });

    // Merge rather than replace: `settings` is shared with businessTypes and
    // whatever else has been parked there, and clobbering it would silently
    // wipe unrelated workspace configuration.
    const current = this.asObject(ws?.settings);
    const onboarding = this.asObject(current.onboarding);
    const next: Prisma.InputJsonValue = {
      ...current,
      onboarding: { ...onboarding, dismissed },
    };

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { settings: next },
    });
    return { dismissed };
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private readDismissed(settings: unknown): boolean {
    const onboarding = this.asObject(this.asObject(settings).onboarding);
    return onboarding.dismissed === true;
  }
}
