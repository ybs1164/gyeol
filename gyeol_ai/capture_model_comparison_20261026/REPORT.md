# 기존 모델과 facing 모델의 평균 포획 타일 비교 — 2026-10-26

현재 모델의 동일 조건 비교에서 기존 모델은 한 판 평균 17.53장, facing은 14.47장을 뒤집었다. facing의 포획량이 3.06장(17.5%) 적었다.

두 모델은 각자의 규칙에서 같은 가중치가 양쪽을 맡는 자가대국으로 비교했다. 시작은 모두 인접 마주보기 `초록→ 갈색←`이며 초록이 정규 첫 수를 둔다. 양쪽이 한 판에서 뒤집은 누적 타일 수를 합산하고 재포획도 다시 센다.

배치당 32국·수당 MCTS 100회, seed=2026102617, 첫 6수 확률 선택, 이후 최다 방문 수, 8개 회전·반사 균등 배분, cpuct=1.5, 루트 노이즈 없음. 모델·수순을 고정하고 모든 대국을 재생했다.

| 모델 | 한 판 평균 포획 | 턴당 평균 | 포획 턴 비율 | 포획 한 번당 평균 |
|---|---:|---:|---:|---:|
| 기존 모델 (방향 자유) | 17.53장 | 0.76장 | 48.2% | 1.58장 |
| facing 모델 (상대 바라보기) | 14.47장 | 0.63장 | 44.8% | 1.40장 |
| 참고: facing-free-start 모델 | 16.56장 | 0.70장 | 48.0% | 1.47장 |

facing − 기존의 한 판 평균 차이는 -3.062장, 기존 대비 변화율은 -17.5%다. 대국 단위 재표집 차이의 근사 95% 구간은 -4.906~-1.125장이다. 방향 안에서 대국을 10,000회 재표집했으며 같은 대국 번호를 짝지었다. 한 대국 안의 턴을 독립 표본으로 취급하지 않았다.

## 양쪽의 포획량

| 모델 | 선공 평균 포획 | 후공 평균 포획 | 평균 첫 포획 턴 |
|---|---:|---:|---:|
| 기존 모델 (방향 자유) | 9.47장 | 8.06장 | 7.66수 |
| facing 모델 (상대 바라보기) | 7.69장 | 6.78장 | 7.00수 |
| 참고: facing-free-start 모델 | 7.66장 | 8.91장 | 5.19수 |

## 해석 범위와 검증

기존 모델은 새 타일 방향을 자유롭게 선택하며 facing은 돌린 상대 타일을 바라보게 놓는다. 별도로 학습한 모델도 함께 다르므로 차이를 규칙 변경만의 인과 효과로 해석하지 않는다. 같은 탐색 횟수라도 합법 수의 개수는 다르다. 이 결과는 현재 두 모델과 인접 마주보기 배치에 조건부이며 다른 배치나 최적 플레이에서의 차이를 확정하지 않는다. 포획량과 승률도 별개다.

매 수의 합법성, 최종 보드·승패, 양쪽 포획량과 점수 차이의 일치, seed·방향 배분을 확인했다. 각 모델의 첫 대국은 별도로 엔진의 뒤집힌 칸 목록과 포획 수열을 매 턴 대조했다. 기존 모델의 새 32국과 앞서 완료된 facing 32국을 비교했으며 과거 facing 모델의 결과는 섞지 않았다.

## 모델 해시

- 기존 모델 (방향 자유): `fd65121de8f9dc70c323152d3a59d859ddb81d9f7dbaefda623bded6d4263fc3`
- facing 모델 (상대 바라보기): `0b4f3d055d0d9858edcceb62e5ca920b8d080ebf8b38e04b1a9b2c71694aa1d4`
- 참고: facing-free-start 모델: `28bf57afe3d262cd9d2dd7c9e329975c956285688812b76e151c31d5a5b69c22`

## 재현

```powershell
python select_facing_openings.py --model-kind original --model temp/best.pth.tar --output capture_model_comparison_20261026/original --label confirm --ids 11 --games 32 --sims 100 --seed 2026102617 --batch-size 32
python compare_model_captures.py --original capture_model_comparison_20261026/original/confirm.json --facing facing/evaluations/adjacent-20261026/confirm.json --free-start facing-free-start/evaluations/intuitive-20261026/confirm.json --output capture_model_comparison_20261026
```

같은 출력 폴더에서는 고정 모델과 완료된 대국을 재사용한다. 새로운 폴더에서 같은 모델로 재현하려면 --model에 저장된 original/model.pth.tar를 지정한다.
