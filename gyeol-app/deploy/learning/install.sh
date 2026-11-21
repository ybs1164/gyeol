#!/usr/bin/env bash
# 지속 학습 설치(Oracle 서버). 여러 번 실행해도 된다.
#   sudo bash install.sh [--seed-dir DIR] [--no-timer]
# --seed-dir: best.pth.tar(배포 모델의 학습 체크포인트), trainExamples.examples(자가대국), labels-*.jsonl(초기 라벨)
#
# 하는 일: 학습 계정 gyeol-train, 코드 /opt/gyeol-training(저장소·Node 의존성·Python venv),
#          데이터 /var/lib/gyeol-training(0700), systemd gyeol-learning.service/.timer(매일 02:00 KST)
# 하지 않는 일: 게임 서비스(gyeol)·운영 DB·백업·SSH·방화벽·Caddy·OCI 리소스 변경, 모델 배포
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo" >&2; exit 1; }
ROOT=/opt/gyeol-training
DATA=/var/lib/gyeol-training
NODE_BIN=/opt/gyeol/runtime/bin
REPO_URL=https://github.com/ybs1164/gyeol.git
seed="" timer=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --seed-dir) seed=$2; shift 2 ;;
    --no-timer) timer=0; shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
done
log() { echo "== $*"; }
[[ -x $NODE_BIN/node ]] || { echo "Node runtime not found at $NODE_BIN (install the gyeol server first)" >&2; exit 1; }
[[ -d /var/backups/gyeol/hourly ]] || { echo "No /var/backups/gyeol/hourly (gyeol backups are required)" >&2; exit 1; }

log "account and folders"
id gyeol-train &>/dev/null || useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin gyeol-train
install -d -o root -g root -m 0755 "$ROOT"
install -d -o gyeol-train -g gyeol-train -m 0700 "$DATA"
for d in model export labels seed-labels candidates reports snapshot; do install -d -o gyeol-train -g gyeol-train -m 0700 "$DATA/$d"; done

log "repository"
if [[ -d $ROOT/repo/.git ]]; then git -C "$ROOT/repo" pull --ff-only --quiet; else git clone --quiet "$REPO_URL" "$ROOT/repo"; fi
git -C "$ROOT/repo" log -1 --format='   %h %s'
chmod 0755 "$ROOT/repo/gyeol-app/deploy/learning/"*.sh

log "node dependencies"
(cd "$ROOT/repo/gyeol-app" && PATH="$NODE_BIN:$PATH" npm ci --no-audit --no-fund --loglevel=error)

log "python venv"
if ! python3 -c 'import ensurepip' 2>/dev/null; then
  apt-get install -y --no-install-recommends python3-venv || { apt-get update && apt-get install -y --no-install-recommends python3-venv; }
fi
[[ -x $ROOT/venv/bin/python ]] || python3 -m venv "$ROOT/venv"
"$ROOT/venv/bin/pip" install --quiet --upgrade pip
"$ROOT/venv/bin/pip" install --quiet torch numpy onnx onnxruntime tqdm
"$ROOT/venv/bin/python" -c "import torch, numpy, onnx, onnxruntime; print('   torch', torch.__version__, 'numpy', numpy.__version__, 'onnx', onnx.__version__, 'onnxruntime', onnxruntime.__version__)"

if [[ -n $seed ]]; then
  log "seed files from $seed"
  for f in best.pth.tar trainExamples.examples; do
    if [[ -f $seed/$f && ! -f $DATA/model/$f ]]; then install -o gyeol-train -g gyeol-train -m 0600 "$seed/$f" "$DATA/model/$f"; echo "   $f"; fi
  done
  for f in "$seed"/labels-*.jsonl; do
    if [[ -f $f && ! -f $DATA/seed-labels/$(basename "$f") ]]; then
      install -o gyeol-train -g gyeol-train -m 0600 "$f" "$DATA/seed-labels/"; echo "   $(basename "$f")"
    fi
  done
fi
expected=$("$ROOT/venv/bin/python" -c "import json;print(json.load(open('$ROOT/repo/gyeol-app/apps/web/public/model/model-info.json'))['sha256'])")
if [[ -f $DATA/model/best.pth.tar && $(sha256sum "$DATA/model/best.pth.tar" | cut -d' ' -f1) == "$expected" ]]; then
  echo "   base checkpoint matches the deployed model"
else
  echo "   WARNING: $DATA/model/best.pth.tar missing or not the deployed model ($expected); cycles will stop until it is copied"
fi

log "python tests"
(cd "$ROOT/repo/gyeol_ai" && PYTHONDONTWRITEBYTECODE=1 "$ROOT/venv/bin/python" -m unittest facing.test_distill 2>&1 | tail -3)

log "systemd"
install -m 0644 "$ROOT/repo/gyeol-app/deploy/learning/gyeol-learning.service" /etc/systemd/system/
install -m 0644 "$ROOT/repo/gyeol-app/deploy/learning/gyeol-learning.timer" /etc/systemd/system/
systemctl daemon-reload
if [[ $timer == 1 ]]; then systemctl enable --now gyeol-learning.timer; systemctl list-timers gyeol-learning.timer --no-pager | head -2; fi
log "done. Run once now: sudo systemctl start gyeol-learning.service; follow: journalctl -u gyeol-learning -f"
