-- Reverts 0057_prospect_purpose: the column and its check. A prospect's purpose goes with it; the
-- research tasks keep the entries they name (an ad-hoc task's `kind.icp_key`, which the release
-- before reads past). Repeatable.
alter table if exists prospects drop constraint if exists prospects_icp_key_check;
alter table if exists prospects drop column if exists icp_key;
