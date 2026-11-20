# 지속 학습 도구

계획: [`docs/continuous-learning-plan.md`](../../docs/continuous-learning-plan.md)

## P0 기준선

| 명령 | 하는 일 |
|---|---|
| `npx tsx tools/learning/build_exact_test_set.ts --per 400 --workers 7` | 얼린 정확 시험 세트 `frozen/exact-test-v1.*`를 만든다. 이미 있으면 중단한다(다시 만들지 않고 버전을 올린다) |
| `npx tsx tools/learning/score_model.ts --model <model.onnx> --sims 64` | 모델 하나를 시험 세트로 채점해 `reports/`에 저장한다. 같은 모델이면 같은 숫자가 나온다 |
| `npx tsx tools/bench_standard_vs_deep.ts` | 빠른 분석이 정밀 분석과 얼마나 일치하는지 잰다(한 판 정밀 분석 약 13~15분) |

## P1 수집 (서버에서 실행)

```bash
node db-cli.mjs export-training --db /var/lib/gyeol/gyeol.sqlite --out /var/lib/gyeol-training/export \
  --exclude <repo>/gyeol-app/tools/learning/frozen/exact-test-v1.jsonl [--player-cap 5000] [--min-plies 3] [--max-games 0]
```

- 운영 DB를 **읽기 전용**으로 연다. 게임 서버가 돌고 있어도 된다(SQLite WAL).
- 끝난 온라인 대국(사람끼리, 사람 대 봇)을 국면 단위로 펼쳐 `positions-<실행 번호>-<시각>.jsonl`에 쓴다. 한 줄: `board`, `player`(둘 차례), `remaining`, `ply`, `mode`, `ranked`, `mover`/`opponent`(`human`|`bot`).
- 닉네임·계정 ID·토큰·시각·승패는 쓰지 않는다. 정답은 P2 재분석이 만든다.
- 같은 국면은 8대칭·색 맞바꿈까지 합쳐 한 번만 쓴다(`symmetryKey`). `--exclude` 세트의 국면은 쓰지 않으며, `--exclude` 없이는 실행하지 않는다. 강제 패스 국면은 버린다.
- 사람 한 명이 둘 차례인 국면은 누적 `--player-cap`개까지. 사람 구분은 `state.json`의 비밀 salt로 만든 HMAC이다. 봇은 상한이 없다.
- `out` 폴더(`state.json`, `seen-keys.txt`, 국면 파일)는 0600/0700으로 만들고 서버 밖으로 옮기지 않는다. 다시 실행하면 커서 뒤의 새 대국만 읽는다.

## P2 재분석 라벨 (서버에서 실행)

```bash
npx tsx tools/learning/relabel.ts --in /var/lib/gyeol-training/export --out /var/lib/gyeol-training/labels \
  [--model apps/web/public/model/model.onnx] [--sims 800] [--workers 2] [--budget-minutes 0] [--max 0]
```

| 단계 | 남은 타일 | 가치(둘 차례 기준) | 정책 | 타일 차이 |
|---|---|---|---|---|
| `exact` | ≤ 6 | 정확 승패 | 최선 차이를 내는 수 전부 균등 | 정확 |
| `proven` | 7~9 | 정확 승패 | 깊은 탐색 방문 분포 | 7장만 정확 |
| `search` | ≥ 10 또는 정확 탐색 한도 초과 | 추천 수의 Q | 깊은 탐색 방문 분포 | 없음 |

- 라벨 로직은 `packages/ai/src/training-labels.ts`(`labelPosition`), 시험은 `packages/ai/test/training-labels.test.ts`.
- 남은 타일이 적은 국면부터 처리한다. `--budget-minutes`가 지나면 새 국면을 시작하지 않고, 남은 국면은 다음 실행에서 이어 한다.
- 라벨 한 줄: `key`(대칭 키), `tier`, `board`(정규 보드, 둘 차례 = +1), `remaining`, `value`, `margin`, `policy`(`[행동, 확률]`), `search`(`sims`, `q`, `mean`, `model` = ONNX sha256 앞 16자; 정확 단계는 `null`).
- 같은 대칭 키는 한 번만 라벨한다. 작업자가 강제 종료되면 `.part-*.jsonl`이 남고, 다음 실행이 먼저 합친다(잘린 줄은 버림).
- 탐색 라벨은 만든 모델에 묶인다. 모델이 바뀐 뒤 낡은 탐색 라벨을 다시 만드는 것은 P3/P5에서 정한다. 정확 라벨은 모델과 무관하다.

## P3 학습 (gyeol_ai, 서버에서 실행)

```bash
cd gyeol_ai
python train_distill.py --labels /var/lib/gyeol-training/labels --out /var/lib/gyeol-training/candidates/<이름> \
  [--base facing/temp/best.pth.tar] [--replay facing/temp/trainExamples.examples] [--steps 3000] [--label-share 0.5]
python export_facing_onnx.py --checkpoint <후보>/candidate.pth.tar --out <후보>/onnx
cd ../gyeol-app && npx tsx tools/learning/score_model.ts --model <후보>/onnx/model.onnx
```

- 신경망에 **타일 차이 출력**(`m_fc1`, `m_fc2`, `facing/network.py`)을 추가했다. 예전 체크포인트는 이 출력만 새로 초기화해 그대로 불러온다(`load_compatible`). `forward`는 여전히 `(정책, 가치)`만 돌려주므로 자가대국·MCTS·기존 학습은 바뀌지 않는다.
- ONNX 출력: `log_policy`, `value`, `margin`(둘 차례 기준, 장). 앱의 `createPredictor`는 `margin`이 있으면 `Prediction.margin`으로 읽고, 없으면 예전처럼 동작한다.
- `train_distill.py`는 라벨과 자가대국을 배치마다 `--label-share` 비율로 섞어 기존 모델에서 이어 학습한다. 손실 = 정책 교차 엔트로피 + 가치 MSE + `--margin-weight` × 타일 차이 MSE(정답이 있는 행만). 기본 모델 파일은 덮어쓰지 않고 `<out>/candidate.pth.tar`, `<out>/report.json`을 쓴다.
- 라벨 키를 Python에서 다시 계산해 TS 키와 다르면 멈춘다(대칭 코드 불일치 방지). 얼린 시험 세트 국면은 여기서도 뺀다.
- 검증: 라벨의 5%(대칭 키로 고정), 자가대국의 가장 최근 반복(학습에서 제외). 시험: `python -m unittest facing.test_distill`.
- `pilot_positions.ts`는 서버 DB가 작을 때 쓰는 파일럿 전용 도구다(봇 대국, 시험 세트가 뽑힌 대국은 통째로 제외).

### 시험 세트 규칙

- `frozen/`의 국면은 **학습에 절대 넣지 않는다.** 학습 데이터를 만들 때 각 국면의 8가지 대칭을 모두 제외한다. `id`는 `positionKey`(둘 차례를 +1로 바꾼 보드)다.
- 정답은 양쪽이 최선으로 둘 때의 결과이고 초록 기준이다. 남은 타일 4~9장은 승패, 4~7장은 최종 타일 차이까지 있다.
- 정확 탐색이 노드 한도를 넘은 국면은 빠진다. 어려운 국면이 덜 들어갔을 수 있으니 manifest의 `failed`를 같이 본다.
- 비교는 같은 시험 세트 버전끼리만 한다.
