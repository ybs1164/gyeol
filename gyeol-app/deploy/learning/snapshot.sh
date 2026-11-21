#!/usr/bin/env bash
# 지속 학습: 가장 최근 시간별 백업을 학습 폴더에 풀어 놓는다. 운영 DB(/var/lib/gyeol)는 열지 않는다.
# gyeol-learning.service 의 ExecStartPre=+ 로 root 권한에서 실행된다(백업 폴더는 gyeol 계정만 읽을 수 있다).
set -euo pipefail
DATA=${DATA:-/var/lib/gyeol-training}
src=$(ls -1t /var/backups/gyeol/hourly/*.sqlite.gz 2>/dev/null | head -1 || true)
if [[ -z "$src" ]]; then echo "no hourly backup found" >&2; exit 1; fi
dst="$DATA/snapshot"
install -d -o gyeol-train -g gyeol-train -m 0700 "$dst"
tmp=$(mktemp "$dst/.gyeol.XXXXXX")
gunzip -c "$src" > "$tmp"
chown gyeol-train:gyeol-train "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$dst/gyeol.sqlite"
echo "snapshot from $(basename "$src")"
