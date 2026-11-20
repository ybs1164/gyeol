# Facing free-start

빈 판에서 타일 두 장의 초기 배치를 직접 선택한 뒤 facing 규칙으로 진행하는 학습 변형입니다.

1. 초록(선공)이 자기 타일의 방향을 선택합니다. 첫 타일은 중앙에 둡니다.
2. 갈색(후공)이 첫 타일을 기준으로 행·열 각각 -4~+4칸의 상대 위치와 방향을 선택합니다. 같은 칸을 제외한 80개 위치 × 4방향 = 320개 선택이며, 인접하지 않아도 됩니다.
3. 초기 두 수에는 회전·포획이 없습니다. 두 장을 놓으면 초록부터 회전→놓기→포획을 진행합니다. 새 타일은 반드시 방금 돌린 상대 타일을 바라봅니다.

전체 범위는 최대 5×5, 종료 시 25장, 패스와 승패 판정은 facing과 같습니다. 배치 두 수도 최종 승패와 MCTS 방문 분포로 학습합니다. 정규 수 785개 + 배치 출력 324개 = 정책 출력 1109개입니다. 배치 출력 중 중앙의 4개는 첫 수에만 사용합니다.

## 학습

프로젝트 루트에서:

```powershell
python facing-free-start/main.py
python facing-free-start/main.py --hours 1 --games 20 --sims 50
```

처음 실행할 때 현재 `facing/temp/best.pth.tar`에서 잔차망·가치·정규 수 정책을 이어받습니다. 패스 출력도 유지하며, 추가 배치 정책은 로짓 0으로 초기화해 합법 배치 내에서 균등하게 시작합니다. 초기 배치 선택 능력은 이후 학습해야 합니다. 기존 facing의 리플레이는 가져오지 않습니다.

결과는 실행 위치에 관계없이 `facing-free-start/temp/`에 저장합니다. 다시 실행하면 이곳의 모델·리플레이로 재개합니다. `initialization.json`에 원본 가중치 해시와 초기화 방식을 기록합니다. 모델 교체 평가는 기존 free-start처럼 선후공을 교환하고, 절반의 쌍은 빈 판에서, 나머지는 여러 두 타일 배치에서 시작합니다.

```powershell
# 학습 없이 모델 초기화 또는 기존 체크포인트 확인
python facing-free-start/main.py --init-only

# 특정 facing 체크포인트에서 새 실험 시작
python facing-free-start/main.py --checkpoint facing-free-start/experiment-a --init-from facing/temp/best.pth.tar

# 가중치를 새로 초기화하는 별도 실험
python facing-free-start/main.py --checkpoint facing-free-start/from-scratch --from-scratch
```

기본 실행 제한은 약 5시간이며 반복 경계에서 적용됩니다. `--hours 0`은 지정한 반복 수만큼 실행합니다. 이미 체크포인트가 있는 폴더에는 `--init-from`이나 `--from-scratch`를 사용할 수 없습니다.

## 어떤 배치가 더 동등한지 비교

```powershell
# 회전·반사 중복을 제외한 168개 배치의 신경망 가치 선별
python facing-free-start/evaluate.py --screen-only

# 가치 기준 상위 후보 3개와 기존 마주보기 배치: 배치당 16국
python facing-free-start/evaluate.py --openings 4 --games 16 --sims 100

# 첫 평가에서 고른 배치를 다른 seed와 더 많은 대국으로 확인
python facing-free-start/evaluate.py --ids 138 136 139 11 --games 32 --sims 400 --seed 20261025
```

배치 ID는 같은 규칙의 대칭 정규화 보드를 정렬해 부여하므로 모델이 바뀌어도 유지됩니다. 색 교환은 중복으로 제거하지 않습니다. `--openings 1`은 기존 배치만 평가합니다. `--ids`를 사용하면 지정한 배치만 평가합니다.

가치 선별은 방향별 값의 절댓값 중 최댓값이 작은 배치를 우선합니다. 서로 다른 방향의 강한 선공·후공 편향이 평균에서 상쇄되는 문제를 피하기 위한 기준입니다. 실측에서는 고정 모델이 양쪽을 맡고, 첫 6수는 탐색 방문 비율대로 확률 선택하며 이후는 최다 방문 수를 선택합니다. 방향 8개를 균등하게 사용합니다.

평가는 **이미 두 장이 놓인 판에서 초록이 정규 첫 수를 두는 상황**의 유불리를 측정합니다. 빈 판에서 양쪽이 초기 배치를 고르는 능력은 학습의 자가대국·모델 교체 평가가 담당합니다.

평가 시작 때 모델을 복사하고 `evaluations/날짜-시간/`에 `model.pth.tar`, `screen.json`, `results.json`, 배치 그림·승률·95% 구간·평균 타일 차이가 있는 `REPORT.md`를 저장합니다. 모든 대국을 재생해 합법성과 결과를 검사합니다.

```powershell
# 동일 출력 폴더와 동일 평가 설정으로 중단된 평가 재개
python facing-free-start/evaluate.py --output facing-free-start/evaluations/my-run --openings 4 --games 16 --sims 100
```

처음부터 특정 이름을 쓰려면 첫 실행에도 같은 `--output`을 지정합니다. 재개 시에는 이 폴더의 고정 모델을 사용합니다. `--model`은 새 평가의 모델 원본을 지정합니다. 평가 설정이나 대국 수를 바꾸려면 새 출력 폴더를 사용합니다.

현재 정규 facing 가중치로는 학습하지 않은 먼 배치의 평가가 부정확할 수 있습니다. 신경망 가치가 0에 가깝다는 것만으로 동등한 배치라고 판단하지 않습니다. 여러 후보 중 승률 50%에 가까운 배치를 고른 다음 독립 seed와 추가 대국으로 확인해야 합니다. 학습 중 `temp/opening_games.jsonl`은 모델이 바뀌는 탐험 기록이므로 고정 모델의 배치별 승률과 구분합니다.

2026-10-24 초기 가중치의 [168개 배치 가치 선별](evaluations/initial-screen-20261024/REPORT.md)과 [4개 배치의 예비 비교](evaluations/initial-pilot-20261024/REPORT.md)를 저장했습니다. 수당 100회·배치당 8국에서 선공 승률은 기존 배치 11이 75%, 후보 136이 37.5%, 후보 138·139가 각각 25%였습니다. 136은 표본상 50%에 가장 가깝지만 95% 구간이 넓으므로 동등한 배치라고 확정할 수 없습니다. 배치 선택 정책을 학습하기 전의 예비 결과입니다.

## 검증

```powershell
python facing-free-start/test_facing_free_start.py
python free-start/test_free_start.py
python -m unittest facing.test_facing
```

전체 1280개 초기 선택 조합, facing 전이, 대칭, 가중치 이전 후 정규 예측 보존, 배치 정책의 실제 학습, 로그 재생, 저장·재개 및 평가 명령을 검사합니다. 테스트의 체크포인트는 임시 폴더에만 만듭니다.
