# 돌린 타일을 바라보는 규칙 학습

프로젝트 루트에서 실행:

```powershell
python train_facing.py
python train_facing.py --hours 1 --games 20 --sims 50
```

새 타일은 돌린 상대 타일의 상하좌우 빈 칸에 놓으며, 화살표는 반드시 그 상대 타일을 향합니다. 예를 들어 상대 타일의 오른쪽에 놓으면 새 타일은 왼쪽을 봅니다. 상대 타일의 회전 방향과는 별개입니다. 초기 배치, 포획, 5×5 범위 제한, 패스 및 승패 판정은 기존 규칙을 사용합니다.

- `rules.py`: 전용 규칙과 액션 인코딩. 칸 49 × 회전 방향 4 × 놓을 위치 4 + 패스 = 785개입니다.
- `network.py`: 전용 신경망 클래스와 785개 정책 출력. 공통 잔차망 구조와 학습 코드를 재사용하되 가중치는 새로 학습합니다.
- `temp/`: 전용 모델, 리플레이, 검증 데이터, 학습 지표. 기존 `temp/`, `free-start/temp/`와 분리됩니다.

기본 실행 시간은 약 5시간이며 반복 단위로 종료합니다. 재실행하면 이 폴더의 `best.pth.tar`와 리플레이를 불러옵니다. `--hours 0`은 시간 제한 없이 지정한 반복 수만큼 학습합니다. 기존 3137개 출력 모델 및 웹 서버와는 직접 호환되지 않습니다.

검증: `python -m unittest facing.test_facing`

빈 판에서 선공·후공이 초기 타일을 한 장씩 선택하는 변형은 [`facing-free-start/README.md`](../facing-free-start/README.md)를 참고하세요. `python facing-free-start/main.py`로 현재 facing 가중치에서 이어 학습하고, `python facing-free-start/evaluate.py`로 두 타일 배치별 선후공 승률을 비교할 수 있습니다.

웹 AI 모델 적용: 프로젝트 루트에서 `python publish_facing_model.py`를 실행하면 최신 `facing/temp/best.pth.tar`를 ONNX로 검증·변환해 `N:/Projects/ybs1164.github.io/gyeol/facing/`에 적용합니다. 브라우저 규칙과 Python 규칙의 일치 여부는 `python test_facing_web.py`로 확인합니다. 공개 절차는 웹 프로젝트의 `gyeol/facing/README.md`를 참고하세요.
