#!/usr/bin/env bash
# 지속 학습 한 회차: 수집 → 정답 라벨 → (조건이 되면) 학습 → ONNX → 자동 관문. 모델을 배포하지 않는다.
# gyeol-learning.service 가 gyeol-train 계정, 가장 낮은 CPU 우선순위로 실행한다.
set -euo pipefail
REPO=${REPO:-/opt/gyeol-training/repo}
DATA=${DATA:-/var/lib/gyeol-training}
VENV=${VENV:-/opt/gyeol-training/venv}
NODE_BIN=${NODE_BIN:-/opt/gyeol/runtime/bin}
LABEL_MINUTES=${LABEL_MINUTES:-240}   # 하루 라벨 시간 예산(분)
LABEL_SIMS=${LABEL_SIMS:-800}
TRAIN_MIN_NEW=${TRAIN_MIN_NEW:-20000} # 지난 학습 뒤 새 라벨이 이만큼이면 학습
TRAIN_MAX_DAYS=${TRAIN_MAX_DAYS:-14}  # 또는 이 일수가 지나고
TRAIN_MIN_ANY=${TRAIN_MIN_ANY:-2000}  #   새 라벨이 이 이상이면 학습
TRAIN_STEPS=${TRAIN_STEPS:-3000}
FORCE_TRAIN=${FORCE_TRAIN:-0}

export PATH="$NODE_BIN:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LEARNING_REPORTS="$DATA/reports"
app="$REPO/gyeol-app"
tsx="$app/node_modules/.bin/tsx"
py="$VENV/bin/python"
frozen="$app/tools/learning/frozen/exact-test-v1.jsonl"
log() { echo "[$(date -u +%FT%TZ)] $*"; }
cd "$app"

# 배포 모델과 학습 기준 체크포인트가 같은지 확인한다(다르면 배포 후 체크포인트 교체를 잊은 것).
expected=$("$py" -c "import json;print(json.load(open('apps/web/public/model/model-info.json'))['sha256'])")
actual=$(sha256sum "$DATA/model/best.pth.tar" | cut -d' ' -f1)
if [[ "$expected" != "$actual" ]]; then
  log "base checkpoint $actual does not match deployed model $expected; copy the deployed best.pth.tar to $DATA/model first" >&2
  exit 1
fi

log "export"
"$tsx" packages/server/src/db-cli.ts export-training --db "$DATA/snapshot/gyeol.sqlite" --out "$DATA/export" --exclude "$frozen" > "$DATA/last-export.json"
"$py" -c "import json;r=json.load(open('$DATA/last-export.json'));print('  games',r['games'],'positions',r['positions'])"

log "relabel (${LABEL_MINUTES} min, ${LABEL_SIMS} sims)"
"$tsx" tools/learning/relabel.ts --in "$DATA/export" --out "$DATA/labels" --sims "$LABEL_SIMS" --workers 1 --budget-minutes "$LABEL_MINUTES" > "$DATA/last-relabel.json" || { log "relabel failed"; exit 1; }

# 학습 조건: 지난 학습 뒤 새 라벨 수와 경과 일수
decision=$("$py" - "$DATA" "$TRAIN_MIN_NEW" "$TRAIN_MAX_DAYS" "$TRAIN_MIN_ANY" "$FORCE_TRAIN" <<'PY'
import glob, json, os, sys, time
data, min_new, max_days, min_any, force = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4]), sys.argv[5] == '1'
count = sum(1 for f in glob.glob(f'{data}/labels/labels-*.jsonl') + glob.glob(f'{data}/seed-labels/*.jsonl') for _ in open(f))
state_file = f'{data}/train-state.json'
state = json.load(open(state_file)) if os.path.exists(state_file) else {'labels': 0, 'at': 0}
new, days = count - state['labels'], (time.time() - state['at']) / 86400
train = force or new >= min_new or (days >= max_days and new >= min_any)
print(json.dumps({'train': train, 'labels': count, 'new': new, 'days': round(days, 1)}))
PY
)
log "train decision $decision"
if [[ $("$py" -c "import json,sys;print(json.loads(sys.argv[1])['train'])" "$decision") != True ]]; then
  log "done (no training this cycle)"; exit 0
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
cand="$DATA/candidates/$stamp"
log "train → $cand"
(cd "$REPO/gyeol_ai" && "$py" train_distill.py --labels "$DATA/labels" "$DATA/seed-labels" --out "$cand" \
  --base "$DATA/model/best.pth.tar" --replay "$DATA/model/trainExamples.examples" --steps "$TRAIN_STEPS" --threads 1 --frozen "$frozen")
(cd "$REPO/gyeol_ai" && "$py" export_facing_onnx.py --checkpoint "$cand/candidate.pth.tar" --out "$cand/onnx")
"$py" -c "import json,sys,time;d=json.loads(sys.argv[1]);json.dump({'labels':d['labels'],'at':time.time(),'candidate':sys.argv[2]},open(sys.argv[3],'w'))" "$decision" "$cand" "$DATA/train-state.json"

log "gate"
set +e
"$tsx" tools/learning/gate.ts --candidate "$cand/onnx/model.onnx" --out "$cand/gate"
status=$?
set -e
case $status in
  0) log "GATE PASS: $cand/gate/report.md — waiting for approval (nothing deployed)" ;;
  2) log "gate failed: $cand/gate/report.md (current model kept)" ;;
  *) log "gate error ($status)"; exit $status ;;
esac
