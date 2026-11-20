# 라즈베리파이 4B · RAM 4GB 서버 설치

대상: Ubuntu Server 24.04 64비트 ARM64, systemd, 인터넷 연결.
파이에서 빌드하거나 npm install을 실행할 필요가 없습니다.
서버, 웹 앱, 실제 AI 모델·WASM과 검사 프로그램을 포함하며, APK 서명 키와 기존 사용자 데이터는 제외합니다.

## 설치

PC의 `gyeol-pi-server.tar.gz`를 SSH/SCP 등으로 파이 홈 폴더에 복사한 뒤 실행합니다.

```bash
tar -xzf gyeol-pi-server.tar.gz
cd gyeol-pi-server
sudo bash install.sh
```

설치기는 Ubuntu/ARM64를 확인하고 공식 Node.js 22 ARM64 최신 패치를 다운로드해 SHA256을 검사합니다.
Node는 /opt/gyeol에 별도로 설치하므로 시스템 Node를 교체하지 않습니다.
패키지와 Node 다운로드에 인터넷 연결이 필요합니다.
자동 시작, 오류 시 재시작, 시간별 SQLite 백업을 등록합니다. 배포 전 격리 DB에서 친구 대전·재접속·실제 AI·백업 복원을 검사합니다.
기존 JSON이 있으면 진행 중 짧은 대국이 없는 시간에 `sudo bash install.sh --migrate-json`으로 최초 전환합니다.
검사 계정과 대국은 운영 데이터에 추가하지 않습니다. 초기 검사 실패 시 기존 서버를 교체하지 않습니다.

## 접속

```bash
hostname -I
curl http://127.0.0.1:8787/health
sudo systemctl status gyeol --no-pager
```

같은 와이파이 브라우저: http://파이의IP:8787
APK의 설정 → 온라인 서버: 파이의IP:8787
기존 APK에서 주소를 입력하면 되며, 공개 주소 확정 후 기본 주소를 넣어 다시 빌드할 수 있습니다.
HTTP 내부망 웹 페이지는 브라우저의 보안 컨텍스트 제한으로 PWA 등 일부 기능이 제한될 수 있습니다.
설치기는 공유기, 방화벽, SSH 설정을 변경하지 않습니다.
UFW가 활성화되어 있으면 관리자 판단으로 실제 내부망 대역에 한해서 8787/tcp를 허용하세요.

이 설치만으로 외부 인터넷에 공개되지는 않습니다.
공인 IP와 포트포워딩이 가능하면 무료 DDNS와 HTTPS 프록시로 외부 접속을 구성할 수 있습니다.
CGNAT 등으로 포트포워딩이 불가능하면 외부 연결 방식을 먼저 정해야 합니다.
공개 HTTPS 주소가 확정되기 전에는 임시 터널 주소를 APK 기본값에 넣지 않습니다.

## 설정과 관리

- 설정: /etc/gyeol/server.env (업데이트 시 보존)
- 데이터: /var/lib/gyeol/gyeol.sqlite (업데이트 시 보존, 토큰 해시 저장). 기존 JSON은 원본으로 보관합니다.
- 코드: /opt/gyeol/current → /opt/gyeol/releases/release-*
- Node: /opt/gyeol/runtime/bin/node
- 백업: /var/backups/gyeol/hourly (48시간), daily (14일), 이전·배포 직전 별도 백업
- 메모리: JS 힙 768MB, 서비스 전체 상한 2GB, 1.5GB부터 회수 압력 적용
- 로그: systemd journal. 보관량은 기존 OS 설정을 따릅니다.

```bash
sudo journalctl -u gyeol -n 80 --no-pager
sudo journalctl -u gyeol -f
sudo systemctl restart gyeol
sudo systemctl stop gyeol
sudo systemctl list-timers gyeol-backup.timer
sudo systemctl start gyeol-backup.service
sudo bash check.sh --ai
```

봇을 끄려면 `sudo nano /etc/gyeol/server.env`로 AI_DIR=off로 변경하고 재시작합니다.
봇을 끈 상태의 검사는 `sudo bash check.sh`로 실행합니다.
HOST=127.0.0.1로 바꾸면 프록시 전용 접속으로 제한할 수 있습니다. PORT에는 숫자를 지정하세요.
AI 플레이어 1,000명은 프로필 수입니다. 모델 세션과 추론은 공유합니다.
동시 봇 대국이 늘면 파이에서 실제 응수 지연을 측정해야 합니다.
초기에는 친구 대전과 소수 봇 대국으로 시작하세요. 이 배포 작업은 동시 대국 한도를 추가하지 않습니다.

## SQLite updates and recovery

The installer validates the native driver and complete release in an isolated DB before stopping the existing server. It flushes legacy JSON before import, preserves source/configuration backups, and blocks client commands with `/var/lib/gyeol/maintenance` until DB and backup checks pass. Run `install.sh --migrate-json` only during scheduled maintenance for the initial JSON transition. Future updates use `install.sh`.

Client traffic can create new state after the maintenance gate opens. Do not restore the old JSON after that point: it would lose new accounts, moves and ratings. Use a verified SQLite backup. Stop both the backup timer/service and game server before replacing the DB, preserve the old DB together with its WAL/SHM, and restore an independent checked snapshot. Keep restored files owned by `gyeol` with mode 0600.

Full migration, verification, restore and management instructions are in `docs/database-operations.md` in the source project. The deployed tools are `db-cli.mjs` and `validate-package.mjs`:

```bash
sudo -u gyeol /opt/gyeol/runtime/bin/node /opt/gyeol/current/db-cli.mjs verify --db /var/lib/gyeol/gyeol.sqlite
sudo systemctl status gyeol-backup.service --no-pager
sudo journalctl -u gyeol-backup -n 20 --no-pager
```

The backup job uses Online Backup API and checks a restored copy. Never gzip/copy the live SQLite main file alone. Copy completed daily backups to another device; external destination credentials are not configured automatically. Downtime continues to count against existing game clocks.

## PC에서 다시 패키징

프로젝트 루트에서 `npm run package:pi`를 실행합니다.
타입 검사와 웹/서버 빌드 후 dist/gyeol-pi-server.tar.gz 및 SHA256 파일을 생성합니다.
Windows node_modules를 파이로 복사할 필요가 없습니다.

## 검증 범위

PC에서 압축 파일의 서버로 HTTP/WebSocket·친구 대전 완주·재접속·실제 모델 AI 응수를 검사합니다.
설치 스크립트의 Bash 문법도 검사합니다.
파이 ARM64 실행, systemd와 재부팅 후 자동 시작, 모바일 외부 접속은 파이에 설치한 뒤 확인해야 합니다.
