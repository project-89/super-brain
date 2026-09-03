#!/bin/sh
set -eu

: "${SUPER_BRAIN_BACKUP:?SUPER_BRAIN_BACKUP is required}"
: "${FOLD_RESTORE_DATABASE_URL:?FOLD_RESTORE_DATABASE_URL must name a disposable restore database}"

checksum="$SUPER_BRAIN_BACKUP.sha256"
test -f "$checksum"
(
  cd "$(dirname "$SUPER_BRAIN_BACKUP")"
  shasum -a 256 -c "$(basename "$checksum")"
)
pg_restore --list "$SUPER_BRAIN_BACKUP" >/dev/null
pg_restore \
  --dbname "$FOLD_RESTORE_DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --exit-on-error \
  "$SUPER_BRAIN_BACKUP"
printf 'Restore verification completed against the disposable database.\n'
