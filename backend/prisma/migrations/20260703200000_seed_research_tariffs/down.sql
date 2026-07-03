-- Rollback: delete exactly the seeded RESEARCH default tariffs by their fixed ids.
-- Tightly scoped — never touches workspace-authored tariff rows.
DELETE FROM "channel_tariffs" WHERE "id" IN (
  '9e5f0000-0000-4000-8000-0000000000a1',
  '9e5f0000-0000-4000-8000-0000000000a2',
  '9e5f0000-0000-4000-8000-0000000000a3'
);
