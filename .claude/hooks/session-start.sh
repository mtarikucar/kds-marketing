#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Provisions a full, self-contained dev/test stack so web sessions can run the
# DB-backed work this sandbox otherwise can't: real-Postgres e2e, `prisma
# migrate dev` (generating new migrations), and a bootable backend for
# Playwright screenshots. Runs synchronously so deps + DB are guaranteed ready
# before the agent starts (no race). Container state is cached after the hook,
# so the slow first run (apt install) is paid once.
#
# Idempotent and non-interactive. Web-only — skips on local machines.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export DEBIAN_FRONTEND=noninteractive
log() { echo "[session-start] $*"; }

# --- Node dependencies (cached after the hook completes) ---
log "Installing backend deps…"
( cd "$ROOT/backend" && npm install --no-audit --no-fund >/dev/null )
log "Installing frontend deps…"
( cd "$ROOT/frontend" && npm install --no-audit --no-fund >/dev/null )

# --- PostgreSQL server (client + pg_ctlcluster are preinstalled in the image) ---
if ! ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1; then
  log "Installing PostgreSQL server…"
  apt-get update -y >/dev/null
  apt-get install -y --no-install-recommends postgresql >/dev/null
fi

PGVER="$(ls /etc/postgresql 2>/dev/null | sort -n | tail -1 || true)"
if [ -n "$PGVER" ]; then
  pg_ctlcluster "$PGVER" main start 2>/dev/null \
    || service postgresql start 2>/dev/null || true
fi

for _ in $(seq 1 30); do
  pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
  sleep 1
done

DB_URL="postgresql://marketing:marketing@localhost:5432/marketing?schema=public"
if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  psql_pg() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; }
  psql_pg -tAc "SELECT 1 FROM pg_roles WHERE rolname='marketing'" | grep -q 1 \
    || psql_pg -c "CREATE ROLE marketing LOGIN PASSWORD 'marketing' SUPERUSER;"
  psql_pg -tAc "SELECT 1 FROM pg_database WHERE datname='marketing'" | grep -q 1 \
    || psql_pg -c "CREATE DATABASE marketing OWNER marketing;"
  log "PostgreSQL ready on localhost:5432 (db: marketing)"

  log "Applying Prisma migrations…"
  ( cd "$ROOT/backend" \
      && DATABASE_URL="$DB_URL" npx prisma generate >/dev/null \
      && DATABASE_URL="$DB_URL" npx prisma migrate deploy )
else
  log "WARN: PostgreSQL did not become ready — DB-backed tasks will be unavailable"
fi

# --- Redis (preinstalled) for distributed rate-limit / cache experiments ---
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null 2>&1 || true

# --- Persist environment for the session (so the backend boots without a manual .env) ---
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export DATABASE_URL=\"$DB_URL\""
    echo "export REDIS_URL=\"redis://localhost:6379\""
    echo "export NODE_ENV=\"development\""
    # Dev-realm secrets: ≥32 chars and distinct (MarketingModule validates this).
    echo "export MARKETING_JWT_SECRET=\"dev-marketing-access-secret-000000000000\""
    echo "export MARKETING_JWT_REFRESH_SECRET=\"dev-marketing-refresh-secret-1111111111\""
    echo "export PLATFORM_JWT_SECRET=\"dev-platform-operator-secret-22222222222\""
    echo "export INTERNAL_SERVICE_TOKEN=\"dev-internal-service-token-3333333333\""
    echo "export RESEARCH_ROUTINE_TOKEN=\"dev-research-routine-token-4444444444\""
    echo "export CORE_SERVICE_URL=\"http://localhost:3000\""
    echo "export AI_DISABLED=\"1\""
  } >> "$CLAUDE_ENV_FILE"
  log "Session env written (DATABASE_URL, REDIS_URL, dev secrets)"
fi

log "Environment ready."
