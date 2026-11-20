#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run: sudo bash install.sh' >&2; exit 1; fi
if [[ $(uname -m) != aarch64 ]]; then echo 'A 64-bit ARM Ubuntu installation is required (uname -m: aarch64).' >&2; exit 1; fi
if [[ ! -d /run/systemd/system ]]; then echo 'systemd is required.' >&2; exit 1; fi
source /etc/os-release
deploy_target=${GYEOL_DEPLOY_TARGET:-pi}
if [[ $deploy_target == oracle ]]; then
  if [[ ${ID:-} != ubuntu || ! ${VERSION_ID:-} =~ ^(22\.04|24\.04)$ ]]; then
    echo 'Oracle deployment requires Ubuntu 22.04 or 24.04 ARM64.' >&2; exit 1
  fi
elif [[ $deploy_target != pi || ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
  echo 'Pi deployment requires Ubuntu Server 24.04 ARM64.' >&2; exit 1
fi
migrate_json=0
seed_db=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --migrate-json) migrate_json=1; shift ;;
    --seed-db)
      if [[ $# -lt 2 || ! -f $2 ]]; then echo '--seed-db requires a completed SQLite backup file.' >&2; exit 1; fi
      seed_db=$(readlink -f -- "$2"); shift 2 ;;
    *) echo 'Use install.sh [--migrate-json | --seed-db BACKUP.sqlite]' >&2; exit 1 ;;
  esac
done
if [[ $migrate_json == 1 && -n $seed_db ]]; then echo 'Choose JSON migration or a SQLite seed, not both.' >&2; exit 1; fi
bundle_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$bundle_dir"
sha256sum --check SHA256SUMS
apt-get update
apt-get install -y ca-certificates curl xz-utils
# Use an isolated official Node 22 runtime, leaving the system Node installation alone.
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work_dir/SHASUMS256.txt"
node_archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz$/ {print $2}' "$work_dir/SHASUMS256.txt")
if [[ ! $node_archive =~ ^node-v22\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz$ ]]; then echo 'Cannot resolve the official Node ARM64 release.' >&2; exit 1; fi
curl --fail --silent --show-error --location --retry 3 "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$work_dir/$node_archive"
(cd "$work_dir" && awk -v name="$node_archive" '$2 == name' SHASUMS256.txt | sha256sum --check -)
install -d -m 0755 /opt/gyeol /opt/gyeol/releases
node_dir=${node_archive%.tar.xz}
if [[ ! -d /opt/gyeol/$node_dir ]]; then tar -xJf "$work_dir/$node_archive" -C /opt/gyeol; fi
/opt/gyeol/"$node_dir"/bin/node --version
if ! id gyeol >/dev/null 2>&1; then useradd --system --user-group --home-dir /var/lib/gyeol --shell /usr/sbin/nologin gyeol; fi
install -d -m 0700 -o gyeol -g gyeol /var/lib/gyeol
install -d -m 0700 -o gyeol -g gyeol /var/backups/gyeol
install -d -m 0755 /etc/gyeol
if [[ ! -f /etc/gyeol/server.env ]]; then install -m 0644 server.env.example /etc/gyeol/server.env; fi
release_dir=$(mktemp -d /opt/gyeol/releases/release-XXXXXXXX)
cp -a server.mjs database.worker.mjs db-cli.mjs smoke.mjs validate-package.mjs migrations node_modules public "$release_dir/"
chown -R root:root "$release_dir"
chmod -R a+rX "$release_dir"
new_node="/opt/gyeol/$node_dir/bin/node"
# Validate the actual Linux ARM64 addon and release files in a disposable DB first.
runuser -u gyeol -- "$new_node" "$release_dir/validate-package.mjs" "$release_dir" --ai
if [[ -n $seed_db ]]; then "$new_node" "$release_dir/db-cli.mjs" restore-check --source "$seed_db"; fi
set -a
source /etc/gyeol/server.env
set +a
legacy_source=${DATA:-/var/lib/gyeol/gyeol.json}
target_db=${DB_PATH:-/var/lib/gyeol/gyeol.sqlite}
if [[ $(readlink -m "$target_db") != /var/lib/gyeol/* ]]; then echo 'DB_PATH must be inside /var/lib/gyeol.' >&2; exit 1; fi
if [[ -n $seed_db && ( -e $target_db || -f $legacy_source ) ]]; then
  echo 'Seed requires a new installation with no existing SQLite or JSON; existing data was preserved.' >&2; exit 1
fi
if [[ -z ${DB_PATH:-} && -f "$legacy_source" && -f "$target_db" ]]; then
  echo 'Unconfigured SQLite exists alongside legacy JSON. Preserve it under another name before importing the final JSON snapshot.' >&2
  exit 1
fi
if [[ -f "$legacy_source" && ! -f "$target_db" && $migrate_json != 1 ]]; then
  echo 'Legacy JSON detected. Schedule maintenance with no active timed games, then run install.sh --migrate-json.' >&2
  exit 1
fi
previous_release=''
previous_runtime=''
if [[ -L /opt/gyeol/current ]]; then previous_release=$(readlink -e /opt/gyeol/current || true); fi
if [[ -L /opt/gyeol/runtime ]]; then previous_runtime=$(readlink -e /opt/gyeol/runtime || true); fi
stamp=$(date -u +%Y%m%dT%H%M%S)-$$
env_backup="/var/backups/gyeol/server-env-$stamp"
cp /etc/gyeol/server.env "$env_backup"
chmod 0600 "$env_backup"
for unit in gyeol.service gyeol-backup.service gyeol-backup.timer; do
  if [[ -f /etc/systemd/system/$unit ]]; then cp "/etc/systemd/system/$unit" "$work_dir/$unit.previous"; fi
done
if [[ -f /usr/local/sbin/gyeol-backup ]]; then cp /usr/local/sbin/gyeol-backup "$work_dir/backup.previous"; fi
if [[ -e /var/lib/gyeol/maintenance ]]; then echo 'Existing maintenance gate found; resolve it before deployment.' >&2; exit 1; fi
maintenance_file=/var/lib/gyeol/maintenance
target_preexisted=0
if [[ -f "$target_db" ]]; then target_preexisted=1; fi
backup_timer_active=0
if systemctl is-active --quiet gyeol-backup.timer; then backup_timer_active=1; fi
rollback_before_open() {
  status=$?
  if [[ $status != 0 ]]; then
    systemctl stop gyeol.service 2>/dev/null || true
    cp "$env_backup" /etc/gyeol/server.env
    chmod 0644 /etc/gyeol/server.env
    for unit in gyeol.service gyeol-backup.service gyeol-backup.timer; do
      if [[ -f $work_dir/$unit.previous ]]; then cp "$work_dir/$unit.previous" "/etc/systemd/system/$unit"; fi
    done
    if [[ -f $work_dir/backup.previous ]]; then install -m 0755 "$work_dir/backup.previous" /usr/local/sbin/gyeol-backup; fi
    systemctl daemon-reload
    # A failed first conversion must not be reused after the old JSON server resumes.
    # Preserve it for diagnosis; a retry imports the newly flushed JSON afresh.
    if [[ $target_preexisted == 0 && -f $target_db ]]; then
      mv -- "$target_db" "$target_db.failed-$stamp"
      for suffix in -wal -shm; do
        if [[ -e $target_db$suffix ]]; then mv -- "$target_db$suffix" "$target_db.failed-$stamp$suffix"; fi
      done
    fi
    if [[ -n $previous_release && -d $previous_release && -n $previous_runtime && -d $previous_runtime ]]; then
      ln -sfn "$previous_release" /opt/gyeol/current
      ln -sfn "$previous_runtime" /opt/gyeol/runtime
      if ! systemctl restart gyeol.service; then echo 'Previous service could not restart; inspect journalctl -u gyeol.' >&2; fi
      if [[ $backup_timer_active == 1 ]]; then systemctl restart gyeol-backup.timer || true; fi
      echo 'Pre-open deployment failed. Previous release/configuration restored; inspect the service log.' >&2
    else
      echo 'Deployment failed. Service remains stopped. Data and diagnostics were preserved.' >&2
    fi
    rm -f -- "$maintenance_file"
  fi
  rm -rf -- "$work_dir"
}
trap rollback_before_open EXIT
# Stop background backups too, so no stale backup process races the transition.
if systemctl is-active --quiet gyeol-backup.timer; then systemctl stop gyeol-backup.timer; fi
if systemctl is-active --quiet gyeol-backup.service; then systemctl stop gyeol-backup.service; fi
# Stop normally so the previous JSON server flushes its final state.
if systemctl is-active --quiet gyeol.service; then systemctl stop gyeol.service; fi
# Keep clients gated until data and startup checks pass. Internal recovery may run.
touch "$maintenance_file"
chown gyeol:gyeol "$maintenance_file"
if [[ ! -f "$target_db" ]]; then
  if [[ -n $seed_db ]]; then
    install -o gyeol -g gyeol -m 0600 "$seed_db" "$target_db"
  elif [[ -f "$legacy_source" ]]; then
    gzip -c "$legacy_source" > "/var/backups/gyeol/before-sqlite-$stamp.json.gz"
    runuser -u gyeol -- "$new_node" "$release_dir/db-cli.mjs" import-json --source "$legacy_source" --db "$target_db" --report "/var/lib/gyeol/import-$stamp.json"
  else
    runuser -u gyeol -- "$new_node" "$release_dir/db-cli.mjs" migrate --db "$target_db"
  fi
else
  # Back up with the previous schema-compatible CLI before applying new migrations.
  backup_cli="$release_dir/db-cli.mjs"
  backup_node="$new_node"
  if [[ -f "$previous_release/db-cli.mjs" && -x "$previous_runtime/bin/node" ]]; then
    backup_cli="$previous_release/db-cli.mjs"; backup_node="$previous_runtime/bin/node"
  fi
  runuser -u gyeol -- "$backup_node" "$backup_cli" backup --db "$target_db" --output "/var/backups/gyeol/predeploy-$stamp.sqlite"
  runuser -u gyeol -- "$new_node" "$release_dir/db-cli.mjs" migrate --db "$target_db"
fi
runuser -u gyeol -- "$new_node" "$release_dir/db-cli.mjs" verify --db "$target_db"
# Appended values override old DATA/defaults while retaining the original config backup.
printf '\nSTORAGE=sqlite\nDB_PATH=%s\nMAINTENANCE_FILE=%s\n' "$target_db" "$maintenance_file" >> /etc/gyeol/server.env
ln -sfn "$release_dir" /opt/gyeol/current
ln -sfn "/opt/gyeol/$node_dir" /opt/gyeol/runtime
install -m 0644 gyeol.service gyeol-backup.service gyeol-backup.timer /etc/systemd/system/
install -m 0755 backup.sh /usr/local/sbin/gyeol-backup
systemctl daemon-reload
systemctl enable gyeol.service gyeol-backup.timer
systemctl restart gyeol.service
healthy=0
for attempt in $(seq 1 30); do
  if /opt/gyeol/runtime/bin/node "$bundle_dir/check-health.mjs"; then healthy=1; break; fi
  sleep 1
done
if [[ $healthy != 1 ]]; then journalctl -u gyeol -n 40 --no-pager; exit 1; fi
systemctl restart gyeol-backup.timer
systemctl start gyeol-backup.service
# Client traffic can now create new state: automatic rollback to legacy JSON ends here.
rm -f -- "$maintenance_file"
trap 'rm -rf -- "$work_dir"' EXIT
echo 'GYEOL SQLite deployment passed. Hourly backup enabled. Client maintenance gate opened.'
echo 'Package smoke tests used an isolated database; no test accounts were added to production.'
if [[ $deploy_target == oracle ]]; then
  echo 'Oracle A1 ready: http://127.0.0.1:8787 (use your SSH tunnel to access from a PC).'
else
  echo 'LAN URL: http://<PI-IP>:8787 ; APK settings: <PI-IP>:8787'
fi
echo 'No router or firewall settings were changed. Public HTTPS/WSS is a separate step.'
