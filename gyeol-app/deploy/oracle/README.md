# Oracle A1 Flex 설치

Ubuntu 22.04/24.04 ARM64와 sudo를 사용하는 서버에 설치한다. 다른 OS이면 설치기는 변경 전에 중단한다. 기존 시스템 Node와 SSH·방화벽 설정은 유지한다.

패키지를 기존 SSH/SFTP 연결로 서버 홈에 업로드한 뒤:

```bash
tar -xzf ~/gyeol-oracle-server.tar.gz
cd ~/gyeol-oracle-server
sudo bash install.sh
```

PC에서 검증한 기존 계정·기보를 함께 가져오려면 별도로 제공한 완료 백업 `gyeol-initial-backup.sqlite`도 서버 홈에 올리고, 마지막 명령을 `sudo bash install.sh --seed-db ~/gyeol-initial-backup.sqlite`로 실행한다. 이미 서버 데이터가 있으면 덮어쓰지 않고 중단한다. 앱 패키지는 계정 데이터를 포함하지 않는다.

SQLite/WAL, DB worker, 실제 AI, systemd 자동 시작과 재시작, 시간별 백업 및 일별 14일 보관을 적용한다. 설치 전 실제 ARM64 환경에서 격리 DB의 대국·재접속·AI·백업 복원을 검사한다. 운영 DB에는 검사 계정을 만들지 않는다.

기존 GYEOL JSON이 있으면 진행 중 대국을 확인하고 `sudo bash install.sh --migrate-json`을 사용한다. SQLite·JSON 등 기존 사용자 데이터는 패키지에 포함하지 않는다. 새 서버는 새 계정 데이터로 시작한다. PC의 기존 데이터 이전이 필요하면 원본을 보존한 별도 이전 절차를 따른다.

확인:

```bash
curl --fail http://127.0.0.1:8787/health
sudo systemctl status gyeol --no-pager
```

서버는 기본적으로 127.0.0.1:8787에서 실행된다. 사용 중인 SSH 프로그램에서 로컬 포트 8787을 서버의 127.0.0.1:8787로 전달하면 PC 브라우저의 `http://localhost:8787`로 접속할 수 있다. OpenSSH를 사용하는 경우 기존 개인키·접속 옵션에 포트 전달 옵션을 더한다:

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@146.56.189.166
```

위 명령은 기존 개인키 인증이 설정된 환경에서 실행한다. 공개키 문자열을 개인키 옵션으로 사용하지 않는다. 기존 역방향 프록시·도메인이 있으면 같은 로컬 서비스로 HTTPS/WSS를 연결할 수 있다. 공개 서비스 연결과 OCI 보안 목록 변경은 자동 수행하지 않는다.

설정: `/etc/gyeol/server.env`. 데이터: `/var/lib/gyeol/gyeol.sqlite`. 백업: `/var/backups/gyeol`. 자세한 백업·복원 방법은 패키지의 `DATABASE.md`를 참고한다. 기존 서비스의 메모리 한도는 2GB이며, 서버의 실제 할당 RAM과 다른 작업을 확인해 조정한다. OCI 인스턴스의 CPU·RAM이나 유료 리소스를 변경하지 않는다.

## 공개 HTTPS/WSS 연결 복구

기본 배포는 loopback에 바인딩한다. 공개 웹 연결이 필요하면 `repair_connection.py`를 서버에서 `sudo python3 repair_connection.py`로 실행한다. 146.56.189.166의 현재 운영 대상에 맞춘 스크립트이며 다른 IP로 재사용하지 않는다.

이 스크립트는 먼저 로컬 health를 확인하고, 활성 Caddy 서비스의 실제 Caddyfile을 찾는다. 기존 파일과 실행 중 API 설정이 다르면 덮어쓰지 않는다. 기존 설정을 `/var/backups/gyeol-connect`에 보존하고 `gyeol.146.56.189.166.sslip.io` 사이트만 추가한 뒤 validate/reload한다. 다른 사이트와 방화벽·SSH·DB는 변경하지 않는다. HTTPS 인증서·웹·WebSocket 업그레이드가 확인되어야 READY를 출력하며, 실패 시 원래 설정을 복원한다. 적용 이후 다른 운영자가 파일을 바꾸면 그 변경을 덮어쓰지 않고 중단한다.

표준 systemd Caddyfile 서비스만 자동 수정한다. Docker/JSON/API 전용 설정, 환경변수에 의존하는 Caddyfile, 유지보수 중인 backend는 자동 변경하지 않고 원인을 출력한다. 성공 URL은 `/etc/gyeol/public-url`에 저장한다.
