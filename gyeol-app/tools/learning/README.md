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

### 시험 세트 규칙

- `frozen/`의 국면은 **학습에 절대 넣지 않는다.** 학습 데이터를 만들 때 각 국면의 8가지 대칭을 모두 제외한다. `id`는 `positionKey`(둘 차례를 +1로 바꾼 보드)다.
- 정답은 양쪽이 최선으로 둘 때의 결과이고 초록 기준이다. 남은 타일 4~9장은 승패, 4~7장은 최종 타일 차이까지 있다.
- 정확 탐색이 노드 한도를 넘은 국면은 빠진다. 어려운 국면이 덜 들어갔을 수 있으니 manifest의 `failed`를 같이 본다.
- 비교는 같은 시험 세트 버전끼리만 한다.
