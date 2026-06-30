import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { VoiceAiBridgeController } from './voice-ai-bridge.controller';

const COMPLETION = {
  id: 'chatcmpl-x',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'selam' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

const CHANNEL = { id: 'ch-1', workspaceId: 'ws-1', type: 'VOICE', agentProfileId: 'ap-1', externalId: '+90', configPublic: {} };

function makeCtrl() {
  const prisma = { channel: { findFirst: jest.fn().mockResolvedValue(CHANNEL) } };
  const service = { complete: jest.fn().mockResolvedValue(COMPLETION) };
  const ctrl = new VoiceAiBridgeController(prisma as any, service as any);
  return { prisma, service, ctrl };
}

const BODY = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'merhaba' }] };

const resStub = () => {
  const res: any = {};
  res.setHeader = jest.fn().mockReturnValue(res);
  res.write = jest.fn().mockReturnValue(true);
  res.end = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res as Response & { setHeader: jest.Mock; write: jest.Mock; end: jest.Mock };
};

describe('VoiceAiBridgeController', () => {
  const OLD = process.env;
  beforeEach(() => {
    process.env = { ...OLD, VOICE_AI_BRIDGE_SECRET: 's3cret' };
  });
  afterAll(() => {
    process.env = OLD;
  });

  it('throws NotFound when the bridge is inert (no secret)', async () => {
    delete process.env.VOICE_AI_BRIDGE_SECRET;
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.chat('ch-1', BODY as any, 'Bearer whatever', resStub() as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('401 on a bad bearer token', async () => {
    const { ctrl, service } = makeCtrl();
    await expect(
      ctrl.chat('ch-1', BODY as any, 'Bearer wrong', resStub() as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('401 when the Authorization header is missing', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.chat('ch-1', BODY as any, undefined as any, resStub() as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('404 when the VOICE channel does not exist', async () => {
    const { ctrl, prisma } = makeCtrl();
    prisma.channel.findFirst.mockResolvedValue(null);
    await expect(
      ctrl.chat('missing', BODY as any, 'Bearer s3cret', resStub() as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('200 OpenAI shape on a good bearer (non-stream JSON)', async () => {
    const { ctrl, prisma, service } = makeCtrl();
    const out = await ctrl.chat('ch-1', BODY as any, 'Bearer s3cret', resStub() as any);
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({ where: { id: 'ch-1', type: 'VOICE' } });
    expect(service.complete).toHaveBeenCalledWith(CHANNEL, BODY);
    expect(out).toBe(COMPLETION);
  });

  it('streams SSE when body.stream is true (single chunk + [DONE])', async () => {
    const { ctrl, service } = makeCtrl();
    const res = resStub() as any;
    const ret = await ctrl.chat('ch-1', { ...BODY, stream: true } as any, 'Bearer s3cret', res);
    expect(ret).toBeUndefined();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(service.complete).toHaveBeenCalled();
    const writes = res.write.mock.calls.map((c: any[]) => c[0]).join('');
    expect(writes).toContain('data: ');
    expect(writes).toContain('data: [DONE]');
    expect(res.end).toHaveBeenCalled();
  });
});
