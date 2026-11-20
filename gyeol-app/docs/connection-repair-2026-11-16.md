# Oracle 공개 연결 복구

상태: 수정 스크립트 작성·로컬 검증·클라우드 게시 완료. 원격 서버 적용은 운영자가 짧은 명령을 실행한 후 외부에서 재검증해야 한다. SSH 개인키가 제공되지 않아 원격 적용 완료로 보고하지 않는다.

적용 후 업데이트: 운영자의 실행 완료 메시지 뒤 외부에서 재검증했다. `https://gyeol.146.56.189.166.sslip.io/health`와 `/`는 HTTP 200이며 `ok:true`, SQLite, `maintenance:false`, 누적 DB 실패 0을 확인했다. TLS 검증을 켠 WebSocket `/ws`는 HTTP 101과 올바른 accept 헤더를 반환했다. 격리 Chrome에서 실제 배포 웹을 열어 별도 서버 주소 설정 없이 WSS 연결·welcome 수신·프로필 `배치 · 1500` 표시를 확인했다. 네트워크 오류와 JavaScript 예외는 없었다. 따라서 현재 외부 웹 연결은 정상이다. SSH 내부 설정을 직접 읽어 확인한 것으로 표현하지 않는다.

브라우저 결과: `tools/oracle-web-validation/public-report.json`, 실제 화면: `oracle-public-lobby.png`. 공개 웹 검사 과정에서 대국 없이 점검용 게스트 1개가 생성되었다.

원인 근거: 배포한 Oracle 패키지는 `HOST=127.0.0.1`, `PORT=8787`이다. 외부에서 22/80/443은 TCP 연결이 되고 8787은 시간 초과다. HTTP의 Caddy는 HTTPS로 리다이렉트하지만 IP 주소 HTTPS는 TLS 협상에 실패한다. 웹 0.4.0의 실제 Chrome 테스트도 Oracle HTTP/WSS 연결 실패와 로컬 서버 연결 성공을 확인했다. 8787 직접 공개 대신 기존 443 Caddy에서 내부 앱으로 프록시하도록 수정한다.

`deploy/oracle/repair_connection.py`는 백엔드 health, 서비스/설정 경로, 실행 중 Caddy와 파일 간 일치를 먼저 검사한다. 기존 설정을 별도 디렉터리에 보존하고 전용 HTTPS/WSS 사이트를 추가한다. native validate와 reload를 수행한 뒤 인증서 검증을 켠 HTTPS health/웹 및 실제 WebSocket 101/accept 헤더를 검사한다. 실패 시 원래 파일과 설정으로 복구한다. 기존 파일이 중간에 변경되면 덮어쓰지 않는다.

대상 URL: `https://gyeol.146.56.189.166.sslip.io`. DNS가 146.56.189.166으로 해석됨을 확인했다. 다른 서비스·DB·방화벽·SSH 설정은 변경하지 않는다.

검증:

- Linux 안전성 테스트 8개 통과: 기존 사이트 보존, 관리 블록 중복 방지, validate 실패 시 무변경, reload 실패 복구, 파일 권한·백업 보존, 동시 운영자 변경 보존.
- 공식 Caddy v2.11.9 Linux 배포 파일을 SHA-256 확인 후 사용해 실제 설정 문법·모듈 검증 통과.
- 상대 경로 import로 유지한 기존 사이트와 새 GYEOL 프록시가 모두 남는지 native adapt 결과 확인.
- 격리 Caddy를 실행해 API 실행 설정과 파일 adapt 결과의 비교가 실제로 일치함을 확인.
- 게시된 소스를 Linux에서 다시 다운로드해 원본 SHA-256 일치 및 `--print-block` 실행 확인.

게시 주소: `https://paste.rs/ECN6l`. 소스에는 계정 토큰·인증 정보·사용자 데이터가 없다. 실제 계정 생성이나 대국 없이 WebSocket 업그레이드까지만 점검한다. 실제 Oracle TLS 발급과 외부 브라우저 접속은 서버 적용 후에만 성공 여부를 판단한다.
