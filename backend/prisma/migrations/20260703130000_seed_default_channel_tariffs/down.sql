-- Rollback: delete exactly the seeded default tariffs by their fixed ids.
-- Tightly scoped — never touches workspace-authored tariff rows.
DELETE FROM "channel_tariffs" WHERE "id" IN (
  '9e5f0000-0000-4000-8000-000000000001',
  '9e5f0000-0000-4000-8000-000000000002',
  '9e5f0000-0000-4000-8000-000000000003',
  '9e5f0000-0000-4000-8000-000000000004',
  '9e5f0000-0000-4000-8000-000000000005'
);
