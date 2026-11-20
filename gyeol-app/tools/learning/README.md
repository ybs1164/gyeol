# 지속 학습 도구

계획: [`docs/continuous-learning-plan.md`](../../docs/continuous-learning-plan.md)

## P0 기준선

| 명령 | 하는 일 |
|---|---|
| `npx tsx tools/learning/build_exact_test_set.ts --per 400 --workers 7` | 얼린 정확 시험 세트 `frozen/exact-test-v1.*`를 만든다. 이미 있으면 중단한다(다시 만들지 않고 버전을 올린다) |
| `npx tsx tools/learning/score_model.ts --model <model.onnx> --sims 64` | 모델 하나를 시험 세트로 채점해 `reports/`에 저장한다. 같은 모델이면 같은 숫자가 나온다 |
| `npx tsx tools/bench_standard_vs_deep.ts` | 빠른 분석이 정밀 분석과 얼마나 일치하는지 잰다(한 판 정밀 분석 약 13~15분) |

### 시험 세트 규칙

- `frozen/`의 국면은 **학습에 절대 넣지 않는다.** 학습 데이터를 만들 때 각 국면의 8가지 대칭을 모두 제외한다. `id`는 `positionKey`(둘 차례를 +1로 바꾼 보드)다.
- 정답은 양쪽이 최선으로 둘 때의 결과이고 초록 기준이다. 남은 타일 4~9장은 승패, 4~7장은 최종 타일 차이까지 있다.
- 정확 탐색이 노드 한도를 넘은 국면은 빠진다. 어려운 국면이 덜 들어갔을 수 있으니 manifest의 `failed`를 같이 본다.
- 비교는 같은 시험 세트 버전끼리만 한다.
