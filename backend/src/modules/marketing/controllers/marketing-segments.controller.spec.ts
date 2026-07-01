import { Reflector } from '@nestjs/core';
import { MarketingSegmentsController } from './marketing-segments.controller';

/**
 * Authorization parity: the `:id/members` route returns actual Lead records for a
 * saved segment, yet it carried NO @RequirePermission while its data siblings
 * `preview` and `count` (which expose LESS) both require `contacts.write`. So any
 * authenticated marketing user — even one without contacts access — could page a
 * segment's lead list. The most data-exposing route must be at least as gated as
 * its siblings. (Probe the SetMetadata the decorator writes, no Nest context.)
 */
describe('MarketingSegmentsController — permission parity', () => {
  const reflector = new Reflector();
  const permOf = (method: keyof MarketingSegmentsController) =>
    reflector.get<string>(
      'requirePermission',
      MarketingSegmentsController.prototype[method] as any,
    );

  it('members requires contacts.write, matching its preview/count siblings', () => {
    expect(permOf('preview')).toBe('contacts.write');
    expect(permOf('count')).toBe('contacts.write');
    expect(permOf('members')).toBe('contacts.write');
  });

  it('the mutating routes keep their contacts.write guard', () => {
    expect(permOf('create')).toBe('contacts.write');
    expect(permOf('update')).toBe('contacts.write');
    expect(permOf('remove')).toBe('contacts.write');
  });
});
