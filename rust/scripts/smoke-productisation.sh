#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${JEETA_TEST_DATABASE_URL:?Set the disposable PostgreSQL administrator URL}"
# TestDb creates ordinary-role disposable databases. Provider effects are recorded locally.
# Restore evidence reuses T9's real Pg contracts; the isolated logical/PITR shell drill is
# separately required by the final release-candidate block.
exec cargo test --locked --workspace \
  --test smoke_productisation --test m4_productisation --test jobs \
  --test billing --test onboarding --test platform --test rls --test m4_billing_storage \
  --test m4_restore --test m4_observability
