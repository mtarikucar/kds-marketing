import { NotFoundException } from '@nestjs/common';
import { MarketingContentLineController } from './marketing-content-line.controller';

const user = { id: 'u-1', workspaceId: 'ws-1' } as never;

function build() {
  const line = { batches: jest.fn() };
  const angles = { byAngle: jest.fn() };
  const row = { id: 'c-1', shotPlan: { shots: [] }, destinations: [] };
  const concepts = { list: jest.fn().mockResolvedValue([row]), planConcepts: jest.fn() };
  const storyboard = {
    request: jest.fn().mockResolvedValue({ conceptId: 'c-1', shots: 3 }),
    regenerateFrame: jest.fn().mockResolvedValue({ conceptId: 'c-1', ord: 2, seed: 5 }),
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

  it('a row that vanished between the write and the read is a 404, not an empty body', async () => {
    const { ctrl, concepts } = build();
    concepts.list.mockResolvedValue([]);
    await expect(ctrl.storyboardConcept(user, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
