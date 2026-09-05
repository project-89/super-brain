#!/usr/bin/env bash
set -euo pipefail

# This runner owns exactly the container ID returned by this invocation. It never
# connects to FOLD_DATABASE_URL or reuses an existing PostgreSQL container.
container_id=""
command_pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$command_pid" ]] && kill -0 "$command_pid" 2>/dev/null; then
    kill "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
  fi
  if [[ -n "$container_id" ]]; then docker rm --force "$container_id" >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: scripts/disposable-postgres.sh [--] [command [arguments...]]

Start isolated PostgreSQL 17/pgvector on a random loopback port, create a
NOSUPERUSER NOBYPASSRLS test role, export FOLD_TEST_DATABASE_URL to the command,
then remove only this invocation's container on success, failure, or interrupt.
Default command: pnpm --filter @_89/super-brain-api test test/postgres-concurrency.test.ts
Build the API and its workspace dependencies before running integration tests.
HELP
  exit 0
fi
if [[ "${1:-}" == "--" ]]; then shift; fi

container_id=$(docker run --detach --rm \
  --label super-brain.test-purpose=disposable-postgres \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=disposable_admin \
  --env POSTGRES_DB=super_brain_test \
  pgvector/pgvector:pg17)

ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "$container_id" pg_isready -U postgres -d super_brain_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$container_id" >&2
  exit 1
fi

docker exec -i "$container_id" psql -U postgres -d super_brain_test -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE ROLE fold_app LOGIN PASSWORD 'fold_test' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT, CREATE ON DATABASE super_brain_test TO fold_app;
SQL

binding=$(docker port "$container_id" 5432/tcp)
test_port=${binding##*:}
if [[ ! "$test_port" =~ ^[0-9]+$ ]]; then
  printf 'Unable to determine the isolated database port.\n' >&2
  exit 1
fi
export FOLD_TEST_DATABASE_URL="postgres://fold_app:fold_test@127.0.0.1:${test_port}/super_brain_test"
unset FOLD_DATABASE_URL
if [[ $# == 0 ]]; then
  set -- pnpm --filter @_89/super-brain-api test test/postgres-concurrency.test.ts
fi
"$@" &
command_pid=$!
printf 'Disposable PostgreSQL ready at 127.0.0.1:%s (restricted fold_app role).\n' "$test_port"
wait "$command_pid"
command_pid=""
