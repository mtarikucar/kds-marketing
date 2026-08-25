import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `Message.externalMessageId` must be unique PER WORKSPACE, never globally.
 *
 * A provider only guarantees its message ids are unique within one
 * business/page/account, so two tenants can legitimately be handed the same id.
 * Under the old global `@unique` that was a collision: the second tenant's
 * insert hit P2002, and because ConversationIngressService correctly refuses to
 * resolve a foreign row it re-threw — their webhook failed and the message
 * never landed. Fail-closed, so nothing leaked, but the message was still lost.
 *
 * This is a schema-level guarantee, so it is asserted at the schema. A unit
 * test with a mocked Prisma cannot tell the two constraints apart.
 */
describe('Message.externalMessageId uniqueness', () => {
  const schema = readFileSync(join(__dirname, '../../../../prisma/schema.prisma'), 'utf8');
  const messageBlock = schema.slice(
    schema.indexOf('model Message {'),
    schema.indexOf('@@map("messages")'),
  );

  it('scopes the provider message id to the workspace', () => {
    expect(messageBlock).toMatch(/@@unique\(\[workspaceId,\s*externalMessageId\]\)/);
  });

  it('does NOT declare it globally unique', () => {
    // The regression that matters: re-adding `@unique` on the field silently
    // reintroduces cross-tenant collisions, and every mocked unit test passes.
    expect(messageBlock).not.toMatch(/externalMessageId\s+String\?\s+@unique/);
  });
});
