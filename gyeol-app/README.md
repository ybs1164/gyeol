# 결 GYEOL — 웹 · 안드로이드 · 온라인 (v1.0)

돌리고, 놓고, 뒤집는 2인 전략 보드게임. AI는 기기 안에서(ONNX, Web Worker) 돌고, 온라인 대국은 작은 Node 서버 하나로 운영합니다.

## 바로 플레이하기

**웹:** https://ybs1164.github.io/gyeol/ — `main`에 push하면 GitHub Actions(`.github/workflows/pages.yml`)가 GitHub Pages에 올립니다. Pages에는 정적 웹 앱만 있고, 온라인 대국(WebSocket)과 퍼즐 API는 Oracle 게임 서버를 씁니다.

로컬에서 직접 실행하려면:

```bash
npm install
npm run build      # 웹 앱 + 서버 빌드
npm run db:import-json -- --source packages/server/data/gyeol.json --db packages/server/data/gyeol.sqlite
npm start          # http://localhost:8787 (웹 앱과 온라인 서버를 함께 제공)
```

- **이 PC:** http://localhost:8787
- **같은 와이파이의 휴대폰 브라우저:** 서버가 시작할 때 출력하는 주소 (예: `http://192.168.0.7:8787`). Windows 방화벽이 물으면 "개인 네트워크 허용"을 선택하세요.
- **안드로이드 앱(APK):** `apps/web/android/app/build/outputs/apk/` 의 APK를 설치합니다. AI 대국, 둘이서, 규칙 배우기, 복기는 서버 없이 동작합니다. 퍼즐은 처음 한 번 서버에서 은행을 받은 뒤 오프라인에서도 풀 수 있습니다. 온라인 대국은 앱의 **설정 → 온라인 서버**에 위 주소(예: `192.168.0.7:8787`)를 넣으세요.

## 기능

| 구분 | 내용 |
|---|---|
| AI 대국 | 입문/보통/어려움/최강, 선후공, 되돌리기 |
| 온라인 | 랭크전(Glicko-2, 시간패, 사람 상대가 없으면 8초 뒤 레이팅이 비슷한 AI 플레이어와 매칭), 친구 대국(5자리 코드·초대 링크, 시간 제한 없는 비동기), 접속 표시, 기권, 순위표 |
| 둘이서 | 한 기기로 번갈아 두기 |
| 규칙 배우기 | 6단계 직접 두기 |
| 오늘의 퍼즐 | 서버가 기보에서 발췌한 정답 하나짜리 승리 문제, 상대 최선 응수와 종국까지 두기, 연속 기록·결과 공유 |
| 퍼즐 도전 | 서버가 보관 기보와 온라인 대국에서 계속 발췌하는 정답 하나짜리 문제(`GET /api/puzzles`). 우세 만들기·역전·승리 굳히기, AI 레이팅 기준 8단계, 출처 표시, 첫 풀이만 Elo 반영 |
| 기록과 복기 | 끝난 대국 100판 저장, 승률 추정 그래프와 전체 수 자동 평가, 7단계 색상·착수 타일 등급 아이콘, 추천 수 비교, 후반 정확 탐색, 분석 중지·재개·저장. 빠른 등급은 잠정, 확률 보정은 검증 중 |
| 설정 | 한국어·English·日本語·简体中文, 타일 색 4종(색 구분이 쉬운 파랑·주황 포함), 소리, 서버 주소 |

디자인 원칙: 단색 면과 얇은 선만 씁니다. 그림자, 빛, 그라데이션은 쓰지 않습니다.

승률 분석의 현재 구현 범위, 속도 측정, 확률 보정 파일럿은 [실행 결과](docs/win-probability-execution.md)에 기록했습니다.

수 등급은 최선 대비 AI 평가점 손실로 정하고, 종국까지 확인한 수는 승·무·패 결과로 설명합니다. 복기에서 평가 기준, 판정 이유, 실제 수·추천 수의 비교와 후속 수순을 확인할 수 있습니다. `~` 잠정 등급은 확정 실수 집계에서 제외합니다. [수 평가 구현·검증 결과](docs/move-grading-implementation.md).

## 구성

```
packages/core     규칙 엔진 · 퍼즐 · 튜토리얼 판 · 온라인 프로토콜 타입 (Python 규칙과 1:1)
packages/ai       MCTS · 난이도 (신경망은 주입)
packages/server   온라인 서버: WebSocket(/ws) + 정적 파일, SQLite/WAL + DB worker, Glicko-2
apps/web          React + Vite + PWA, Capacitor 안드로이드(apps/web/android)
tools/            파이썬 규칙 비교 예제 · 아이콘 · AI 메모리 측정
```

## 명령

```bash
npm run dev            # 웹 개발 서버 (5180, /ws 는 8787로 프록시)
npm run server         # 온라인 서버 개발 실행 (tsx)
npm test               # 규칙·퍼즐·튜토리얼·AI·서버·번역 테스트
npm run calibrate:bots # 기준 AI 12종 1,456판 보정 → 서로 다른 AI 1,000명 생성
npm run calibrate:bots -- --validate-roster # 1,000명 전원이 참여하는 별도 1,000판 검증
npm run puzzles        # 서버와 같은 생성기로 정답 하나짜리 은행 생성 → packages/server/data/puzzles/bank.json
npm run bench:memory -- optimized 30   # AI 메모리 측정 (baseline 과 비교 가능)
npm run android:debug  # 디버그 APK
npm run android:release  # 릴리스 APK (축소 + 서명)
```

서버 환경 변수: `PORT`(8787), `HOST`(0.0.0.0), `DB_PATH`(SQLite, `packages/server/data/gyeol.sqlite`), `PUZZLE_BANK`(퍼즐 은행, 기본 DB 폴더/puzzles/bank.json), `STATIC`(웹 앱 폴더), `AI_DIR`(봇이 쓸 모델 폴더, 기본은 웹 앱 폴더 → `apps/web/public`, `off`면 봇 없음), `BOT_WAIT_SECONDS`(봇으로 넘어가기 전 기다리는 시간, 8).

## AI 플레이어 (온라인 봇)

접속자가 적을 때를 위해 서버가 AI 플레이어 1,000명을 둡니다. 모두 실수 확률·탐색 사용 비율이 다릅니다. 랭크전 대기열에서 사람 상대를 `BOT_WAIT_SECONDS`(8초) 안에 못 찾으면, 내 레이팅에 가까운 AI를 고릅니다. 최근 만난 AI 5명은 가능한 한 피하며, 사람끼리 잡히면 언제나 사람이 먼저입니다.

- **실력:** 기준 AI 12종은 실수 확률 99%의 초급부터 MCTS 512회 탐색까지 다릅니다 (`packages/ai/src/persona.ts`). 실측 레이팅과 측정 오차를 고려해 충분히 떨어진 기준점들을 고른 뒤, 각 수마다 이웃 기준점의 행동을 고유한 비율로 섞어 1,000명의 실력을 만듭니다. 모델과 추론 캐시는 서버에서 하나를 공유합니다.
- **레이팅:** 기준점끼리 1,456판을 두고 선후공 효과를 포함한 정규화 Bradley–Terry(Elo 척도) 모형으로 보정합니다. 기준점 평균은 1500이며, 개별 AI 점수는 두 기준점 사이 보간 추정치(`ratingSource: interpolated`)입니다. 1,000명을 각각 독립적으로 정밀 측정한 점수는 아닙니다. 추정치는 소수 둘째 자리까지 보관하고 화면에는 반올림합니다.
- **검증:** 생성된 1,000명 전원이 각각 선공·후공 한 번씩 참여하는 별도 1,000판을 둡니다. 그중 200명 간격의 네 실력 구간에서 강한 쪽 점수율 60% 이상, Wilson 95% 하한 50% 초과를 확인합니다. 한 명 간격의 작은 차이를 통계적으로 보장하는 검사는 아닙니다.
- 봇 레이팅은 고정이고, 봇과 둔 판은 사람 쪽 레이팅만 Glicko-2로 움직입니다.
- 화면에서는 이름 옆에 `AI` 표시가 붙습니다 (`PublicPlayer.bot`).
- 봇은 시간 모드에 맞춰 한 수에 1~6초쯤 생각하는 척하고(남은 시간의 10%를 넘기지 않음), 서버를 다시 켜도 진행 중이던 봇 대국을 이어 둡니다.
- 개별 AI의 대전 전적은 0판부터 시작하며 기준점 대전 전적을 복사하지 않습니다. AI의 티어는 전적 없이 추정 레이팅으로 표시하고, 순위표에는 실제 랭크전 전적이 생긴 상대부터 포함합니다.
- 봇 단계나 실수 확률을 바꾸면 보정과 검증을 다시 실행하세요. 매 판 저장되므로 같은 입력으로 재실행하면 완료한 판은 건너뜁니다. 입력 모델·설정이 달라진 경우 기존 실행 폴더를 보관하고 새로 시작해야 합니다. `-- --fit-only`는 완료된 원자료로 점수만 다시 계산합니다.

[1,000명 목록과 보정·검증 결과](tools/calibration/roster-v2/README.md)를 확인할 수 있습니다. [초기 10종의 보정 기록](tools/calibration/README.md)은 별도로 보관했습니다. 이 점수는 게임 내부 상대 척도이며, 사람 실력에 대한 절대 기준은 아닙니다.

보정 후에는 `npm run build`로 서버에 새 레이팅을 포함시키고 서버를 다시 실행하세요. 개발 실행(`npm run server`)은 원본 JSON을 바로 읽습니다.

## 정답이 하나뿐인 실전 퍼즐 (서버 제공)

퍼즐은 서버가 만듭니다. 서버의 `gyeol-puzzles.timer`가 보관 기보와 운영 DB의 끝난 대국에서, 푸는 쪽 차례마다 이기는 수가 하나뿐이고 실제로 이긴 쪽이 그 수를 둔 후반 국면만 발췌합니다. 모든 값을 가지치기 없는 전수 탐색으로 다시 검사한 뒤 `GET /api/puzzles`로 내려주고, 앱은 같은 기준으로 다시 확인해 기기에 저장합니다. 기준·운영 방법: [서버 퍼즐](docs/server-puzzles.md). 이전 고정 은행의 출처 보고서는 [실전 기보 퍼즐 검증 보고서](tools/record-puzzles/README.md)에 보관했습니다.

이전 임의 생성 3,200문제는 출제에서 제외하고 기록을 보관했습니다. 점수·전적·그래프를 유지하고, 퇴역 문제를 풀던 상태는 백업합니다. 퍼즐 난이도 숫자는 현재 AI 기준점에 맞춘 복잡도 추정치이고, 승리 판정은 끝까지 검증한 결과입니다. AI 점수 척도가 바뀌면 `npm run puzzles`를 다시 실행하세요.

## AI 메모리 최적화

- 추론 캐시에 785칸 정책 전체 대신 합법 수의 확률만 저장하고, LRU로 4,000국면까지만 유지합니다.
- ONNX Runtime 메모리 아레나와 메모리 패턴을 끕니다. 입력 크기가 고정이라 속도 차이는 측정 오차 수준입니다.
- AI를 쓰는 화면이 모두 닫히고 30초가 지나면 워커를 종료해 wasm 메모리를 돌려줍니다.
- 측정 결과(Node, 최강 난이도로 한 판): GC 후 남는 JS 메모리 40.5MB → 13.2MB, 최대 RSS 182MB → 약 157~168MB. 예전 방식은 오래 둘수록 캐시가 최대 약 125MB까지 커졌습니다.
- 릴리스 APK는 코드·리소스 축소(R8)를 켜고, 앱 안에서는 서비스 워커 파일을 넣지 않습니다.

## 릴리스 서명 키

`apps/web/android/gyeol-release.jks`와 `keystore.properties`(비밀번호 포함)는 이 PC에서 처음 만든 서명 키입니다. **잃어버리면 같은 앱으로 업데이트를 낼 수 없으니 안전한 곳에 백업하세요.** 둘 다 git에서 제외됩니다. Play 스토어에 올릴 때는 Play 앱 서명을 쓰면 이 키는 업로드 키가 됩니다.

## AI 모델 갱신

`../gyeol_ai`에서 `publish_facing_model.py`로 만든 `model.onnx`를 `apps/web/public/model/`에 복사하고, `apps/web/src/ai/ai.worker.ts`의 `MODEL_VERSION`을 새 sha256 앞 16자리로 바꿉니다.

## 수순·배치 문자열

수순은 `D4u`처럼 돌린 타일 좌표와 놓는 인접 방향으로 적습니다. 선공·후공을 각각 1부터 세는 두 열로 표시합니다. `r/l/u/d`는 방향이며 소문자는 선공, 대문자는 후공입니다. [구현 안내](docs/move-position-notation-implementation.md)를 참고하세요.

## 규칙이 바뀌면

```bash
npm run fixtures && npm test
```

SQLite setup, import, backup and deployment: [DB operations](docs/database-operations.md). Node 22+ is required. For a fresh installation without JSON, run `npm run db:migrate -- --db packages/server/data/gyeol.sqlite` first. PowerShell users may need `npm.cmd` to preserve CLI flags.
