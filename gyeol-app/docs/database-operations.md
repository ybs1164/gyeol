# SQLite 운영 안내

온라인 계정·대국·레이팅 저장소는 SQLite로 전환했다. 설정·오프라인 기보·퍼즐 진행·분석 캐시는 기기에 남는다. 기존 서버 URL과 토큰 인증, WebSocket 메시지는 유지한다.

## 개발과 이전

Node 22 이상과 `npm install`이 필요하다. Windows PowerShell에서는 `npm` 대신 `npm.cmd`를 사용하면 옵션 전달 문제를 피할 수 있다.

```bash
npm run db:import-json -- --source packages/server/data/gyeol.json --db packages/server/data/gyeol.sqlite
npm run db:verify -- --db packages/server/data/gyeol.sqlite --source packages/server/data/gyeol.json
npm run build
npm start
```

기존 JSON이 전혀 없는 신규 환경만 `npm run db:migrate -- --db packages/server/data/gyeol.sqlite`로 빈 DB를 생성한다. `DB_PATH`는 기존 DB를 가리켜야 한다. 파일 누락·손상·알 수 없는 마이그레이션·수정된 체크섬은 시작 실패다. `DATA`만 설정된 환경은 자동으로 빈 DB를 만들지 않고 실패한다.

이전은 staging DB에 한 트랜잭션으로 삽입하고 무결성·원본 필드·토큰 인증·전체 수순·이력을 비교한 뒤 목적지로 승격한다. 기존 목적지를 덮어쓰지 않는다. 원본 SHA-256과 건수는 `import_runs`에 기록한다. 원본 JSON은 수정하지 않는다.

기존 누락 필드는 이전 서버와 같은 정책으로 보정한다. 불완전 이력은 그대로 유지하며, 보관된 일부 대국에서 점수·전적을 다시 계산하지 않는다. 원본에 없는 과거 수별 시각·RD·이력과 대국의 연결은 추측하지 않는다.

토큰은 SHA-256 해시만 저장한다. 기존 클라이언트의 `welcome.token` 호환을 위해 유효한 요청 토큰을 그 연결의 응답에 사용한다. 원문 토큰이 있는 원본 JSON과 이전 백업은 접근을 제한해 별도 보관한다.

## 코드와 저장 규칙

- `database.ts`: SQL Repository와 트랜잭션 명령. 착수·시계·정산·이력을 처리한다.
- `database.worker.ts` / `database-store.ts`: 전용 작업 스레드와 비동기 명령 호출.
- `migrations/001.sql`: 외래키·고유키·CHECK·인덱스. 후속 변경은 새 파일과 마이그레이션 실행기 갱신으로 추가한다.
- `db-tools.ts` / `db-cli.ts`: 이전·비교 검증·Online Backup API·격리 복원 검사.
- `legacy-store.ts`: 과거 JSON 보정 회귀 테스트 전용. 운영 서버는 사용하지 않는다.

DB는 WAL, `synchronous=FULL`, `foreign_keys=ON`으로 운영한다. 같은 서버의 로컬 디스크에 둔다. 한 번의 업무 명령은 `BEGIN IMMEDIATE`로 최신 상태를 읽고 검증한다. COMMIT 후에만 결과를 전송한다. 오래된 ply/revision과 중복 정산은 재적용하지 않는다. AI 추론은 DB 트랜잭션 밖이다.

현재 규칙 `facing-25-v1`과 초기 배치는 대국마다 명시적으로 보존한다. 온라인 API는 기존처럼 최근 30국을 반환하지만 전체 기보는 DB에 보관한다. 순위표는 점수 인덱스로 후보를 읽고 현재 RD 자격을 판정한 뒤 50명으로 제한한다. 레이팅 이력은 전부 보관한다. 페이지 API와 계정 간 기기 동기화는 후속 작업이다.

## 백업과 복원

```bash
npm run db:backup -- --db packages/server/data/gyeol.sqlite --output /별도경로/gyeol-backup.sqlite
npm run db:restore-check -- --source /별도경로/gyeol-backup.sqlite
```

`backup`은 Online Backup API로 독립 DB를 만든 뒤 복사본의 무결성과 기보를 검사한다. 기존 목적지는 거부한다. 실행 중 DB 본체 파일 하나를 직접 복사·압축하지 않는다.

파이 설치기는 `/var/backups/gyeol/hourly`에 48시간, `daily`에 14일을 보관하는 시간별 백업을 등록한다. predeploy·기존 JSON 백업은 자동 삭제하지 않는다. 외부 장치의 경로·접속 정보가 없으므로 PC/NAS 복사는 자동 구성하지 않는다. 운영자는 완료된 일별 백업을 별도 장치에 하루 한 번 복사하고 성공 시각을 확인해야 한다.

운영 복원은 다음 순서로 한다. 선택한 백업 이후 변경은 유실된다.

1. 백업 타이머·진행 중인 백업 서비스·게임 서버를 모두 중지한다.
2. `/var/lib/gyeol/maintenance`를 만들고, 0700 임시 폴더에 백업 압축을 푼다.
3. `node /opt/gyeol/current/db-cli.mjs restore-check --source <압축을 푼 DB>`를 실행한다.
4. 서버가 중지된 상태에서 기존 DB와 해당 `-wal`·`-shm` 파일을 함께 별도 폴더로 이동해 보존한다.
5. 검증한 독립 DB를 `DB_PATH`에 서비스 계정 소유·0600 권한으로 설치한다. 예전 WAL/SHM을 새 DB 옆에 남기지 않는다.
6. 서버 시작 후 `/health`와 계정·기보를 확인하고 유지보수 파일을 제거한다. 백업 타이머를 재개한다.

매월 별도 경로에서 복원 연습을 한다. 운영 개방 후 이전 JSON으로 단순 복귀하면 새 계정·대국·점수가 사라진다. 토큰 해시에서 원문을 복원할 수도 없으므로 운영 개방 후 JSON 역변환은 지원하지 않는다.

## 배포와 점검

`npm run build:server`는 서버·DB worker·CLI·스모크 검사·SQL 파일을 만든다. `npm run package:pi`는 드라이버 JS와 Linux ARM64 네이티브 모듈을 포함한다. Windows 모듈·기존 사용자 DB·서명 키는 넣지 않는다.

```bash
sudo bash install.sh                 # 신규 또는 기존 SQLite 업데이트
sudo bash install.sh --migrate-json  # JSON 최초 전환: 진행 중 짧은 대국이 없는 시간
```

설치기는 실제 ARM64 런타임에서 격리 DB의 대국·AI·백업·복원을 먼저 검사한다. 기존 서버를 정상 종료해 최종 JSON을 가져온다. 유지보수 파일로 새 클라이언트 명령을 막은 상태에서 운영 DB와 시작을 확인하고, 백업 성공 후 개방한다. 검사 계정·대국을 운영 DB에 만들지 않는다. 개방 전 실패 시 코드와 설정을 복구한다. 향후 스키마가 달라지는 릴리스는 구버전 코드 호환성 및 백업 복원을 별도로 검증해야 한다.

유지보수 중에도 서버의 대국 복구와 시간 초과 처리는 수행한다. 서버 중단 중 시계가 흐르는 현재 정책을 유지하므로 남아 있는 daily 대국의 마감 시각을 이전 전에 확인한다.

`/health`는 DB 읽기·worker 준비·최근 쓰기 실패·누적 명령 및 실패 수·명령 지연을 반환한다. DB 오류는 HTTP 503이다. 유지보수 중에는 `maintenance:true`이고 클라이언트 명령은 `maintenance` 오류로 거부한다. 이후 성공한 쓰기로 최근 쓰기 실패 상태를 해제한다. 경로·토큰·사용자 ID는 노출하지 않는다.

실제 파이의 10/50/100 동시 대국, SD카드 지연, 복구 시간과 외부 백업 성공은 해당 장치에서 측정해야 한다. 다중 서버나 지속적인 쓰기 병목이 필요하면 PostgreSQL과 서버 간 매칭·접속·봇 소유권을 함께 설계한다.
