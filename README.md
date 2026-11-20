# 결(GYEOL)

돌리고, 놓고, 뒤집는 2인 전략 보드게임.

| 폴더 | 내용 |
|---|---|
| [`gyeol-app/`](gyeol-app/README.md) | 웹·안드로이드 앱, 게임 서버, AI 분석(TypeScript) |
| [`gyeol_ai/`](gyeol_ai/README.md) | 신경망 학습 코드(Python, AlphaZero 구조) |

신경망 지속 학습 계획: [`gyeol-app/docs/continuous-learning-plan.md`](gyeol-app/docs/continuous-learning-plan.md)

체크포인트(`*.pth.tar`), 리플레이(`*.examples`), 서버 DB와 학습 데이터는 저장소에 넣지 않는다. 배포용 모델(`gyeol-app/apps/web/public/model/model.onnx`)만 포함한다.
