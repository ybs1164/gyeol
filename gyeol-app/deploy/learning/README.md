# 지속 학습 서버 설치 (Oracle)

계획: [`docs/continuous-learning-plan.md`](../../docs/continuous-learning-plan.md) · 도구: [`tools/learning`](../../tools/learning/README.md)

매일 02:00(KST) 한 회차를 돈다: 최신 시간별 백업 → 학습 국면 내보내기 → 정답 라벨(시간 예산) → 조건이 되면 학습 → ONNX → 자동 관문.
**모델을 배포하지 않는다.** 관문을 통과하면 `/var/lib/gyeol-training/candidates/<시각>/gate/report.md`가 생기고, 사람이 보고 승인한 뒤에만 배포한다.

## 설치

```bash
# PC에서: 배포 모델의 체크포인트·자가대국·초기 라벨을 서버 홈으로
scp best.pth.tar trainExamples.examples labels-*.jsonl ubuntu@<서버>:~/gyeol-learning-seed/
# 서버에서
curl -fsSL https://raw.githubusercontent.com/ybs1164/gyeol/main/gyeol-app/deploy/learning/install.sh -o install.sh   # 또는 저장소에서 복사
sudo bash install.sh --seed-dir ~/gyeol-learning-seed
```

| 위치 | 내용 | 권한 |
|---|---|---|
| `/opt/gyeol-training/repo` | 저장소(공개) | root, 학습 계정은 읽기만 |
| `/opt/gyeol-training/venv` | Python(torch, onnx, onnxruntime) | root |
| `/var/lib/gyeol-training` | 스냅숏·국면·라벨·후보·보고서 | `gyeol-train` 0700 |
| `/etc/systemd/system/gyeol-learning.{service,timer}` | 매일 한 회차 | |

## 자원

- vCPU 1개 서버라서 학습 서비스는 `CPUWeight=1`(게임 서버 기본 100), `Nice=19`, `IOSchedulingClass=idle`이다. 게임 서버가 CPU를 쓰면 학습은 거의 멈춘다.
- 메모리 상한 2.5GB(게임 서버 2GB와 별도). 하루 라벨 시간 예산 240분(`LABEL_MINUTES`).
- 운영 DB는 열지 않는다. root 로 최신 시간별 백업(`/var/backups/gyeol/hourly`)만 풀어 쓴다(최대 1시간 늦음).

## 운영

```bash
sudo systemctl start gyeol-learning.service        # 지금 한 번
journalctl -u gyeol-learning -f                     # 진행 보기
sudo -u gyeol-train cat /var/lib/gyeol-training/train-state.json
sudo systemctl edit gyeol-learning.service          # Environment=LABEL_MINUTES=120 등으로 조정
```

학습 조건: 지난 학습 뒤 새 라벨 20,000개 이상, 또는 14일이 지나고 2,000개 이상(`TRAIN_MIN_NEW`, `TRAIN_MAX_DAYS`, `TRAIN_MIN_ANY`, 강제 `FORCE_TRAIN=1`).

## 새 모델을 승인해 배포한 뒤

1. 저장소의 `apps/web/public/model/`을 새 모델로 바꾸고 올린다(웹·APK·게임 서버 배포는 기존 절차).
2. 서버 `/var/lib/gyeol-training/model/best.pth.tar`를 새 모델의 체크포인트로 바꾼다. 다르면 회차가 시작 전에 멈춘다.
3. `sudo bash install.sh`로 저장소를 갱신한다.
4. 관문 보고서의 "승인 후 할 일"(보정·봇 레이팅·정밀 분석 기준)을 한다.
