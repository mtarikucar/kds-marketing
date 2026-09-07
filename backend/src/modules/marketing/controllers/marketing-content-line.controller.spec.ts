import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { MarketingContentLineController } from './marketing-content-line.controller';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';
import { AUDIT_METADATA } from '../../audit/audit.decorator';

const user = { id: 'u-1', workspaceId: 'ws-1' } as never;

function build() {
  const line = { batches: jest.fn() };
  const angles = { byAngle: jest.fn() };
  const row = { id: 'c-1', shotPlan: { shots: [] }, destinations: [] };
  const concepts = { list: jest.fn().mockResolvedValue([row]), planConcepts: jest.fn() };
  const storyboard = {
    request: jest.fn().mockResolvedValue({ conceptId: 'c-1', shots: 3 }),
    regenerateFrame: jest.fn().mockResolvedValue({ conceptId: 'c-1', ord: 2, seed: 5 }),
    editShot: jest.fn().mockResolvedValue({ conceptId: 'c-1', ord: 2, changed: ['prompt'], redraw: false }),
  };
  const ctrl = new MarketingContentLineController(line as never, angles as never, concepts as never, storyboard as never);
  return { ctrl, concepts, storyboard, row };
}

describe('MarketingContentLineController — storyboard routes', () => {
  it('POST concepts/:id/storyboard asks for the frames as the signed-in person and returns the fresh row', async () => {
    const { ctrl, concepts, storyboard, row } = build();
    await expect(ctrl.storyboardConcept(user, 'c-1')).resolves.toBe(row);
    expect(storyboard.request).toHaveBeenCalledWith('ws-1', 'c-1', 'u-1');
    expect(concepts.list).toHaveBeenCalledWith('ws-1', { conceptId: 'c-1' });
  });

  it('POST concepts/:id/storyboard/:ord/regenerate redraws one beat and returns the fresh row', async () => {
    const { ctrl, storyboard, row } = build();
    await expect(ctrl.regenerateFrame(user, 'c-1', 2)).resolves.toBe(row);
    expect(storyboard.regenerateFrame).toHaveBeenCalledWith('ws-1', 'c-1', 2, 'u-1');
  });

  it('PATCH concepts/:id/shots/:ord hands the beat words to the service as the signed-in person and returns the fresh row', async () => {
    const { ctrl, storyboard, row } = build();
    const body = { keyframePrompt: 'a red bicycle on a white wall', prompt: 'it rolls forward' };
    await expect(ctrl.editShot(user, 'c-1', 2, body)).resolves.toBe(row);
    expect(storyboard.editShot).toHaveBeenCalledWith('ws-1', 'c-1', 2, body, 'u-1');
  });

  it('all three routes can spend image credits, so all need campaigns.write — and all audit the concept they act on', () => {
    for (const name of ['storyboardConcept', 'regenerateFrame', 'editShot'] as const) {
      const handler = MarketingContentLineController.prototype[name];
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('campaigns.write');
      expect(Reflect.getMetadata(AUDIT_METADATA, handler)).toMatchObject({ resourceType: 'content_concept', resourceIdParam: 'conceptId' });
    }
    expect(Reflect.getMetadata(AUDIT_METADATA, MarketingContentLineController.prototype.storyboardConcept).action).toBe('content.line.storyboard');
    expect(Reflect.getMetadata(AUDIT_METADATA, MarketingContentLineController.prototype.regenerateFrame).action).toBe('content.line.storyboard.regenerate');
    expect(Reflect.getMetadata(AUDIT_METADATA, MarketingContentLineController.prototype.editShot).action).toBe('content.line.shot.edit');
  });

  it('a row that vanished between the write and the read is a 404, not an empty body', async () => {
    const { ctrl, concepts } = build();
    concepts.list.mockResolvedValue([]);
    await expect(ctrl.storyboardConcept(user, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
