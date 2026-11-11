-- Commissions leave the product (owner decision, 2026-11-10): nothing creates, lists, approves or
-- pays them any more, so the three tables `0008_inbox_compliance` created for them go. Their
-- row-level policies and the queue index are dropped with them. Stored commission rows are
-- deleted; a later commissions module would bring its own schema. Repeating this is a no-op.
drop table if exists commission_user_rates;
drop table if exists commission_default;
drop table if exists commissions;
