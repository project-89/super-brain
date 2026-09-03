#!/bin/sh
set -eu

: "${FOLD_DATABASE_URL:?FOLD_DATABASE_URL is required}"
: "${SUPER_BRAIN_BACKUP_DIR:?SUPER_BRAIN_BACKUP_DIR is required}"

umask 077
mkdir -p "$SUPER_BRAIN_BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$SUPER_BRAIN_BACKUP_DIR/super-brain-$stamp.dump"

pg_dump --dbname "$FOLD_DATABASE_URL" --format=custom --no-owner --file "$backup"
pg_restore --list "$backup" >/dev/null
(
  cd "$SUPER_BRAIN_BACKUP_DIR"
  shasum -a 256 "$(basename "$backup")" > "$(basename "$backup").sha256"
)
chmod 600 "$backup" "$backup.sha256"
printf '%s\n' "$backup"
