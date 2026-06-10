import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnthropicService } from './anthropic.service';
import { AiCreditsService } from './ai-credits.service';
import { creditCost, tierFor } from './ai-credit-costs';

export interface ComposeDto {
  kind: 'email' | 'sms' | 'social';
  tone?: string;
  goal: string;
  audience?: string;
  /** Optional extra context (e.g. a lead/campaign brief). */
  context?: string;
  variants?: number;
}

export interface ComposeResult {
  subject?: string;
  body: string;
  variants?: string[];
}

/**
 * Content AI — marketing-copy generation (email/SMS/social). Grounded on the
 * workspace's product (name/description). Reserves 1 credit, refunds on
 * failure. The model returns plain text; we parse a lightweight
 * SUBJECT:/BODY: convention for email.
 */
@Injectable()
export class ContentAiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
  ) {}

  async compose(workspaceId: string, dto: ComposeDto): Promise<ComposeResult> {
    if (!this.anthropic.isEnabled()) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { productName: true, productDescription: true, defaultLanguage: true },
    });

    await this.credits.reserve(workspaceId, creditCost('content.compose'));
    try {
      const lang = ws?.defaultLanguage ?? 'tr';
      const limits =
        dto.kind === 'sms'
          ? 'Keep it under 300 characters. No subject line.'
          : dto.kind === 'social'
            ? 'Keep it punchy, social-media-appropriate, with a hook. No subject line.'
            : 'Provide a SUBJECT line then the body.';
      const system = [
        `You are a senior B2B marketing copywriter for "${ws?.productName ?? 'the product'}".`,
        ws?.productDescription ? `Product: ${ws.productDescription}` : '',
        `Write in language code "${lang}". Tone: ${dto.tone ?? 'professional, warm'}.`,
        `Channel: ${dto.kind}. ${limits}`,
        'Output ONLY the copy. For email, format exactly as:\nSUBJECT: <subject>\nBODY:\n<body>',
      ]
        .filter(Boolean)
        .join('\n');

      const userParts = [`Goal: ${dto.goal}`];
      if (dto.audience) userParts.push(`Audience: ${dto.audience}`);
      if (dto.context) userParts.push(`Context: ${dto.context}`);
      const n = Math.min(Math.max(dto.variants ?? 1, 1), 3);
      if (n > 1) userParts.push(`Produce ${n} distinct variants, separated by a line "---".`);

      const res = await this.anthropic.complete({
        system,
        messages: [{ role: 'user', content: userParts.join('\n') }],
        maxTokens: 1500,
        tier: tierFor('content.compose'),
      });

      return this.parse(res.text, dto.kind, n);
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('content.compose'));
      throw e;
    }
  }

  private parse(text: string, kind: ComposeDto['kind'], variantCount: number): ComposeResult {
    const chunks = variantCount > 1 ? text.split(/\n-{3,}\n/).map((c) => c.trim()).filter(Boolean) : [text.trim()];
    const first = chunks[0] ?? text.trim();
    const parseOne = (chunk: string): { subject?: string; body: string } => {
      if (kind === 'email') {
        const m = chunk.match(/^SUBJECT:\s*(.+?)\s*\n+BODY:\s*\n?([\s\S]+)$/i);
        if (m) return { subject: m[1].trim(), body: m[2].trim() };
      }
      return { body: chunk };
    };
    const head = parseOne(first);
    const result: ComposeResult = { subject: head.subject, body: head.body };
    if (chunks.length > 1) {
      result.variants = chunks.map((c) => parseOne(c).body);
    }
    return result;
  }
}
