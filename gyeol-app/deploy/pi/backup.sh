#!/usr/bin/env bash
set -euo pipefail
umask 0077
source /etc/gyeol/server.env
source_file=${DB_PATH:?DB_PATH must be configured}
backup_dir=/var/backups/gyeol
if [[ ! -f "$source_file" ]]; then echo 'SQLite database is missing; backup failed.' >&2; exit 1; fi
mkdir -p "$backup_dir/hourly" "$backup_dir/daily"
# The CLI uses Online Backup API and restores/checks the independent snapshot.
work_dir=$(mktemp -d "$backup_dir/.snapshot-XXXXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT
/opt/gyeol/runtime/bin/node /opt/gyeol/current/db-cli.mjs backup --db "$source_file" --output "$work_dir/snapshot.sqlite"
stamp=$(date -u +%Y%m%dT%H%M%S)
hourly="$backup_dir/hourly/gyeol-$stamp-$$.sqlite.gz"
gzip -c "$work_dir/snapshot.sqlite" > "$hourly.tmp"
mv "$hourly.tmp" "$hourly"
daily="$backup_dir/daily/gyeol-$(date -u +%Y%m%d).sqlite.gz"
if [[ ! -e "$daily" ]]; then cp "$hourly" "$daily.tmp"; mv "$daily.tmp" "$daily"; fi
find "$backup_dir/hourly" -maxdepth 1 -type f -name 'gyeol-*.sqlite.gz' -mmin +2880 -delete
find "$backup_dir/daily" -maxdepth 1 -type f -name 'gyeol-*.sqlite.gz' -mtime +13 -delete
printf 'Backup completed: %s\n' "$hourly"
