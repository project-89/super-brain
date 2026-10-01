#!/bin/sh
set -eu
# This entrypoint runs only for a new owned PostgreSQL volume. Values travel in
# process environment/stdin; passwords are never command arguments or output.
export FOLD_MIGRATION_PASSWORD="$(cat /run/secrets/migration_password)"
export FOLD_RUNTIME_PASSWORD="$(cat /run/secrets/runtime_password)"
export FOLD_RECOVERY_PASSWORD="$(cat /run/secrets/recovery_password)"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password FOLD_MIGRATION_PASSWORD
\getenv runtime_password FOLD_RUNTIME_PASSWORD
\getenv recovery_password FOLD_RECOVERY_PASSWORD
CREATE EXTENSION vector;
CREATE ROLE fold_migrator LOGIN PASSWORD :'migration_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE fold_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE fold_recovery LOGIN PASSWORD :'recovery_password' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE super_brain FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE super_brain TO fold_migrator;
GRANT CONNECT ON DATABASE super_brain TO fold_runtime, fold_recovery;
CREATE SCHEMA fold AUTHORIZATION fold_migrator;
SQL
unset FOLD_MIGRATION_PASSWORD FOLD_RUNTIME_PASSWORD FOLD_RECOVERY_PASSWORD
