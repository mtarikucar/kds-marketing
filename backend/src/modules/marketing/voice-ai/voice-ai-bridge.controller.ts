import {
  Body,
  Controller,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { isVoiceBridgeConfigured } from './voice-ai.config';
import {
  OpenAiChatBody,
  OpenAiChatCompletion,
  VoiceAiBridgeService,
} from './voice-ai-bridge.service';

/**
 * Public OpenAI-compatible custom-LLM endpoint for voice providers
 * (VAPI / Retell / ElevenLabs). The provider points its "custom LLM" base URL
 * at `…/api/public/voice-ai/llm/{channelId}` and authenticates with a shared
 * bearer secret; we answer as if we were OpenAI while the brain stays our
 * Claude + knowledge base (see VoiceAiBridgeService).
 *
 * Inert until `VOICE_AI_BRIDGE_SECRET` is set (404 otherwise) so nothing is
 * reachable before the operator opts in.
 */
@Controller('public/voice-ai')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class VoiceAiBridgeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: VoiceAiBridgeService,
  ) {}

  @Post('llm/:channelId/chat/completions')
  async chat(
    @Param('channelId') channelId: string,
    @Body() body: OpenAiChatBody,
    @Headers('authorization') authorization: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OpenAiChatCompletion | void> {
    // Inert unless the operator has set the shared secret.
    if (!isVoiceBridgeConfigured()) throw new NotFoundException();

    this.assertBearer(authorization);

    const channel = await this.prisma.channel.findFirst({ where: { id: channelId, type: 'VOICE' } });
    if (!channel) throw new NotFoundException('Voice channel not found');

    const completion = await this.bridge.complete(channel as any, body);

    // Streaming branch: providers that ask for SSE get the same completion
    // emitted as a single data chunk followed by the terminal [DONE] sentinel.
    if (body?.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify(completion)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    return completion;
  }

  /** Timing-safe `Bearer <VOICE_AI_BRIDGE_SECRET>` check (length-guard first). */
  private assertBearer(authorization: string | undefined): void {
    const secret = process.env.VOICE_AI_BRIDGE_SECRET ?? '';
    const provided = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    // timingSafeEqual throws on length mismatch — guard first.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid bridge token');
    }
  }
}
