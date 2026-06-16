import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

/** XML-escape any value interpolated into TwiML (mirrors voice-ai.service). */
function xml(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[
        c
      ] as string,
  );
}

/** The five things a keypad digit can do. Stored as a String on IvrOption. */
export const IVR_ACTIONS = [
  'SUBMENU',
  'DIAL',
  'VOICEMAIL',
  'HANGUP',
  'AI_RECEPTIONIST',
] as const;
export type IvrAction = (typeof IVR_ACTIONS)[number];

/** Valid DTMF keys: 0-9, * and #. */
const VALID_DIGITS = new Set([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '*',
  '#',
]);

export interface MenuInput {
  name: string;
  greeting: string;
  enabled?: boolean;
  isRoot?: boolean;
}

export interface OptionInput {
  digit: string;
  label: string;
  action: IvrAction;
  targetMenuId?: string | null;
  dialNumber?: string | null;
}

/**
 * Configurable IVR / phone-tree menus (GoHighLevel parity) that sit IN FRONT OF
 * the existing Twilio Voice-AI flow. This service owns:
 *
 *  - workspace-scoped CRUD for menus + their keypad options (digit uniqueness
 *    per menu, SUBMENU/DIAL targets validated to belong to the same workspace);
 *  - the inbound fall-through decision ({@link getEnabledRootMenu}) — a
 *    workspace with NO enabled root menu is answered by the unchanged AI flow;
 *  - TwiML rendering ({@link renderMenuTwiml} → <Gather numDigits="1">) and the
 *    digit handler ({@link handleDigit}) — both using the same TwiML envelope +
 *    xml() escaping the existing voice module uses. AI_RECEPTIONIST hands off to
 *    the existing flow (the controller calls VoiceAiService.startCall), never
 *    duplicating it.
 */
@Injectable()
export class IvrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private base(): string {
    return this.config.get<string>('PUBLIC_BASE_URL') ?? '';
  }

  /** The webhook action the keypad <Gather> posts to (callback for handleDigit). */
  private digitActionUrl(menuId: string): string {
    return `${this.base()}/api/public/channels/twilio/ivr/${encodeURIComponent(menuId)}`;
  }

  // ─── inbound fall-through ──────────────────────────────────────────────────

  /**
   * The single enabled root menu for a workspace, or null. Drives the webhook
   * fall-through: null → serve the existing Voice-AI flow unchanged.
   */
  async getEnabledRootMenu(workspaceId: string) {
    return this.prisma.ivrMenu.findFirst({
      where: { workspaceId, isRoot: true, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── TwiML rendering ───────────────────────────────────────────────────────

  /** <Say> plain text, or <Play> an absolute audio URL greeting. */
  private greetingTwiml(greeting: string): string {
    const g = (greeting ?? '').trim();
    if (/^https?:\/\//i.test(g)) return `<Play>${xml(g)}</Play>`;
    return `<Say>${xml(g)}</Say>`;
  }

  /**
   * Render a menu as a keypad <Gather numDigits="1"> whose action posts the
   * pressed digit back to the IVR webhook. The greeting is read first, then each
   * option's label. If the caller presses nothing, the menu is re-read once and
   * then the call hangs up (no infinite loop).
   */
  async renderMenuTwiml(workspaceId: string, menuId: string): Promise<string> {
    const menu = await this.prisma.ivrMenu.findFirst({
      where: { id: menuId, workspaceId },
    });
    if (!menu) throw new NotFoundException('IVR menu not found');
    const options = await this.prisma.ivrOption.findMany({
      where: { workspaceId, menuId },
      orderBy: { digit: 'asc' },
    });

    const prompts = [this.greetingTwiml(menu.greeting)];
    for (const o of options) {
      prompts.push(`<Say>For ${xml(o.label)}, press ${xml(o.digit)}.</Say>`);
    }

    return (
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Gather numDigits="1" action="${xml(this.digitActionUrl(menuId))}" method="POST">` +
      prompts.join('') +
      `</Gather>` +
      // No input → reprompt once by replaying the menu, then give up.
      `<Redirect method="POST">${xml(this.digitActionUrl(menuId))}</Redirect>` +
      `</Response>`
    );
  }

  private hangupTwiml(say: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(say)}</Say><Hangup/></Response>`;
  }

  /**
   * Resolve the pressed digit on a menu and return the next TwiML:
   *  - SUBMENU         → the nested menu's <Gather> (via renderMenuTwiml);
   *  - DIAL            → <Dial>E.164</Dial>;
   *  - VOICEMAIL       → <Record> a message, then hang up;
   *  - HANGUP          → <Hangup>;
   *  - AI_RECEPTIONIST → null, signalling the controller to hand off to the
   *                      existing Voice-AI flow (we never duplicate it here);
   *  - unknown digit   → re-prompt by re-rendering this menu.
   *
   * Returns `{ twiml }` for every resolved action, or `{ aiHandoff: true }` for
   * AI_RECEPTIONIST so the public controller can call VoiceAiService.startCall.
   */
  async handleDigit(
    workspaceId: string,
    menuId: string,
    digit: string,
  ): Promise<{ twiml?: string; aiHandoff?: boolean }> {
    const menu = await this.prisma.ivrMenu.findFirst({
      where: { id: menuId, workspaceId },
    });
    if (!menu) throw new NotFoundException('IVR menu not found');

    const option = await this.prisma.ivrOption.findFirst({
      where: { workspaceId, menuId, digit: (digit ?? '').trim() },
    });
    // Invalid / unmapped digit → re-prompt by replaying this menu.
    if (!option) return { twiml: await this.renderMenuTwiml(workspaceId, menuId) };

    switch (option.action as IvrAction) {
      case 'SUBMENU': {
        if (!option.targetMenuId) {
          return { twiml: await this.renderMenuTwiml(workspaceId, menuId) };
        }
        // targetMenu was validated same-workspace at write time; re-scope here.
        return {
          twiml: await this.renderMenuTwiml(workspaceId, option.targetMenuId),
        };
      }
      case 'DIAL': {
        if (!option.dialNumber) {
          return { twiml: this.hangupTwiml('That option is not available.') };
        }
        return {
          twiml:
            `<?xml version="1.0" encoding="UTF-8"?><Response>` +
            `<Dial>${xml(option.dialNumber)}</Dial>` +
            `</Response>`,
        };
      }
      case 'VOICEMAIL': {
        return {
          twiml:
            `<?xml version="1.0" encoding="UTF-8"?><Response>` +
            `<Say>Please leave a message after the tone, then hang up.</Say>` +
            `<Record maxLength="120" playBeep="true"/>` +
            `<Say>We did not receive a recording. Goodbye.</Say><Hangup/>` +
            `</Response>`,
        };
      }
      case 'HANGUP':
        return { twiml: this.hangupTwiml('Thank you for calling. Goodbye.') };
      case 'AI_RECEPTIONIST':
        // Hand off to the EXISTING Voice-AI flow — controller calls startCall.
        return { aiHandoff: true };
      default:
        return { twiml: await this.renderMenuTwiml(workspaceId, menuId) };
    }
  }

  // ─── menu CRUD (workspace-scoped) ──────────────────────────────────────────

  listMenus(workspaceId: string) {
    return this.prisma.ivrMenu.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { options: { orderBy: { digit: 'asc' } } },
    });
  }

  async getMenu(workspaceId: string, id: string) {
    const menu = await this.prisma.ivrMenu.findFirst({
      where: { id, workspaceId },
      include: { options: { orderBy: { digit: 'asc' } } },
    });
    if (!menu) throw new NotFoundException('IVR menu not found');
    return menu;
  }

  async createMenu(workspaceId: string, dto: MenuInput) {
    const isRoot = dto.isRoot ?? false;
    const enabled = dto.enabled ?? true;
    // Only ONE enabled root menu per workspace: demote any other if this is it.
    if (isRoot && enabled) await this.clearOtherRoots(workspaceId, null);
    return this.prisma.ivrMenu.create({
      data: {
        workspaceId,
        name: dto.name,
        greeting: dto.greeting,
        enabled,
        isRoot,
      },
    });
  }

  async updateMenu(workspaceId: string, id: string, dto: Partial<MenuInput>) {
    const existing = await this.assertMenu(workspaceId, id);
    const isRoot = dto.isRoot ?? existing.isRoot;
    const enabled = dto.enabled ?? existing.enabled;
    if (isRoot && enabled) await this.clearOtherRoots(workspaceId, id);
    return this.prisma.ivrMenu.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.greeting !== undefined && { greeting: dto.greeting }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.isRoot !== undefined && { isRoot: dto.isRoot }),
      },
    });
  }

  async deleteMenu(workspaceId: string, id: string) {
    await this.assertMenu(workspaceId, id);
    // Block deletion of a menu still referenced as a SUBMENU target, to avoid
    // dangling phone trees (the option->menu FK only cascades own options).
    const referenced = await this.prisma.ivrOption.findFirst({
      where: { workspaceId, targetMenuId: id },
    });
    if (referenced) {
      throw new BadRequestException(
        'Menu is the target of a SUBMENU option; remove that option first',
      );
    }
    await this.prisma.ivrMenu.delete({ where: { id } });
    return { id };
  }

  // ─── option CRUD (workspace-scoped) ────────────────────────────────────────

  async addOption(workspaceId: string, menuId: string, dto: OptionInput) {
    await this.assertMenu(workspaceId, menuId);
    await this.validateOption(workspaceId, menuId, dto);
    const dupe = await this.prisma.ivrOption.findFirst({
      where: { workspaceId, menuId, digit: dto.digit },
    });
    if (dupe) {
      throw new BadRequestException(
        `Digit "${dto.digit}" is already mapped on this menu`,
      );
    }
    return this.prisma.ivrOption.create({
      data: {
        workspaceId,
        menuId,
        digit: dto.digit,
        label: dto.label,
        action: dto.action,
        targetMenuId: dto.action === 'SUBMENU' ? (dto.targetMenuId ?? null) : null,
        dialNumber: dto.action === 'DIAL' ? (dto.dialNumber ?? null) : null,
      },
    });
  }

  async deleteOption(workspaceId: string, menuId: string, optionId: string) {
    await this.assertMenu(workspaceId, menuId);
    const opt = await this.prisma.ivrOption.findFirst({
      where: { id: optionId, workspaceId, menuId },
    });
    if (!opt) throw new NotFoundException('IVR option not found');
    await this.prisma.ivrOption.delete({ where: { id: optionId } });
    return { id: optionId };
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private async assertMenu(workspaceId: string, id: string) {
    const menu = await this.prisma.ivrMenu.findFirst({
      where: { id, workspaceId },
    });
    if (!menu) throw new NotFoundException('IVR menu not found');
    return menu;
  }

  /** Demote every OTHER enabled root menu in the workspace (keep `keepId`). */
  private async clearOtherRoots(workspaceId: string, keepId: string | null) {
    await this.prisma.ivrMenu.updateMany({
      where: {
        workspaceId,
        isRoot: true,
        ...(keepId ? { id: { not: keepId } } : {}),
      },
      data: { isRoot: false },
    });
  }

  /** Validate digit + action invariants and same-workspace targets. */
  private async validateOption(
    workspaceId: string,
    menuId: string,
    dto: OptionInput,
  ) {
    if (!VALID_DIGITS.has(dto.digit)) {
      throw new BadRequestException(
        `Invalid digit "${dto.digit}" (must be 0-9, * or #)`,
      );
    }
    if (!IVR_ACTIONS.includes(dto.action)) {
      throw new BadRequestException(`Invalid action "${dto.action}"`);
    }
    if (dto.action === 'SUBMENU') {
      if (!dto.targetMenuId) {
        throw new BadRequestException('SUBMENU requires targetMenuId');
      }
      if (dto.targetMenuId === menuId) {
        throw new BadRequestException('SUBMENU cannot target its own menu');
      }
      const target = await this.prisma.ivrMenu.findFirst({
        where: { id: dto.targetMenuId, workspaceId },
      });
      if (!target) {
        throw new BadRequestException(
          'SUBMENU targetMenuId must be a menu in this workspace',
        );
      }
    }
    if (dto.action === 'DIAL') {
      if (!dto.dialNumber || !/^\+[1-9]\d{1,14}$/.test(dto.dialNumber)) {
        throw new BadRequestException('DIAL requires an E.164 dialNumber');
      }
    }
  }
}
