"""Read-only batch snapshot, individual BT estimates, and a reproducible PNG report."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
from scipy import optimize, special, stats
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT / "tools/calibration/cognition-v1"
NOW = datetime.now(ZoneInfo("Asia/Seoul"))
OUT = ROOT / "tools/calibration/rating-distribution" / NOW.strftime("%Y%m%d-%H%M%S")
OUT.mkdir(parents=True, exist_ok=False)

raw = (BATCH / "games.jsonl").read_bytes()
cutoff = raw.rfind(b"\n") + 1
snapshot = raw[:cutoff]
(OUT / "games-snapshot.jsonl").write_bytes(snapshot)
games = [json.loads(line) for line in snapshot.splitlines() if line]
roster = json.loads((BATCH / "roster.json").read_text(encoding="utf-8"))
deployed_source = json.loads((ROOT / "packages/server/src/bot-ratings.json").read_text(encoding="utf-8"))
n = len(roster)
assert n == 1000
assert len({g["n"] for g in games}) == len(games), "Duplicate games"
train = [g for g in games if g["split"] == "train"]
assert train and all(g["mode"] == "blitz" for g in train)
green = np.asarray([g["green"] for g in train], dtype=int)
brown = np.asarray([g["brown"] for g in train], dtype=int)
y = (np.asarray([g["winner"] for g in train], dtype=float) + 1) / 2
assert np.all((green >= 0) & (green < n) & (brown >= 0) & (brown < n))
counts = np.bincount(green, minlength=n) + np.bincount(brown, minlength=n)
assert np.all(counts > 0), "Some profiles have not played"
adjacency = coo_matrix((np.ones(len(train) * 2), (np.r_[green, brown], np.r_[brown, green])), shape=(n, n)).tocsr()
components = connected_components(adjacency, directed=False, return_labels=False)
assert components == 1, "Ratings cannot be compared across disconnected groups"

# Same 500-Elo Gaussian regularization and fitted color effect as the batch runner.
# Optimize in units of 400 Elo for a well-scaled objective.
ln10 = np.log(10)
prior_sd = 500 / 400


def objective(theta):
    z = ln10 * (theta[green] + theta[-1] - theta[brown])
    residual = special.expit(z) - y
    loss = np.sum(np.logaddexp(0, z) - y * z) + np.dot(theta, theta) / (2 * prior_sd**2)
    grad = np.zeros(n + 1)
    grad[:n] = ln10 * (np.bincount(green, weights=residual, minlength=n) - np.bincount(brown, weights=residual, minlength=n))
    grad[-1] = ln10 * residual.sum()
    grad += theta / prior_sd**2
    return float(loss), grad


fit = optimize.minimize(objective, np.zeros(n + 1), jac=True, method="L-BFGS-B",
                        options={"maxiter": 2000, "ftol": 1e-13, "gtol": 1e-7, "maxls": 40})
assert fit.success, str(fit.message)
elo = fit.x[:n] * 400
elo = elo - elo.mean() + 1500
advantage = float(fit.x[-1] * 400)
e = special.expit(ln10 * (fit.x[green] + fit.x[-1] - fit.x[brown]))
info = (ln10 / 400)**2 * e * (1 - e)
rd = np.maximum(60, 1 / np.sqrt(np.bincount(green, weights=info, minlength=n) + np.bincount(brown, weights=info, minlength=n)))
deployed_by_id = {p["id"]: p["rating"] for p in deployed_source["bots"]}
deployed = np.asarray([deployed_by_id[p["id"]] for p in roster], dtype=float)


def distribution(values):
    mean, sd = float(values.mean()), float(values.std(ddof=0))
    ordered = np.sort(values)
    reference = stats.norm.cdf((ordered - mean) / sd)
    d = float(max(np.max(np.arange(1, n + 1) / n - reference), np.max(reference - np.arange(n) / n)))
    shapiro = stats.shapiro(values)
    return {"n": len(values), "mean": mean, "sd": sd, "median": float(np.median(values)),
            "min": float(values.min()), "max": float(values.max()),
            "quantiles": dict(zip(["p05", "p25", "p75", "p95"], map(float, np.quantile(values, [.05, .25, .75, .95])))),
            "skewness": float(stats.skew(values, bias=False)), "excess_kurtosis": float(stats.kurtosis(values, fisher=True, bias=False)),
            "shapiro_W": float(shapiro.statistic), "shapiro_p": float(shapiro.pvalue),
            "fitted_normal_KS_distance": d,
            "within_1sd": float(np.mean(np.abs(values - mean) <= sd)),
            "within_2sd": float(np.mean(np.abs(values - mean) <= 2 * sd))}


current = distribution(elo)
old = distribution(deployed)
tiers = ["bronze", "silver", "gold", "plat", "dia", "master"]
tier_names = ["브론즈", "실버", "골드", "플래티넘", "다이아", "마스터"]
groups = [elo[[p["cognition"]["targetTier"] == tier for p in roster]] for tier in tiers]
tier_details = [{"targetTier": t, "count": len(v), "mean": float(v.mean()), "median": float(np.median(v)),
                 "min": float(v.min()), "max": float(v.max())} for t, v in zip(tiers, groups)]
actual_tiers = {"bronze": int(np.sum(elo < 1300)), "silver": int(np.sum((elo >= 1300) & (elo < 1500))),
                "gold": int(np.sum((elo >= 1500) & (elo < 1600))), "plat": int(np.sum((elo >= 1600) & (elo < 1750))),
                "dia": int(np.sum((elo >= 1750) & (elo < 1900))), "master": int(np.sum(elo >= 1900))}
summary = {"snapshotAt": NOW.isoformat(), "snapshotSha256": hashlib.sha256(snapshot).hexdigest(),
           "completedGames": len(games), "trainGamesUsed": len(train), "heldOutGamesExcluded": len(games) - len(train),
           "plannedGames": 60000, "perBotTrainGames": [int(counts.min()), int(counts.max())],
           "connectedComponents": int(components), "method": "Individual regularized Bradley-Terry, fitted color effect, 500 Elo prior; mean fixed to 1500",
           "optimizer": {"success": bool(fit.success), "iterations": int(fit.nit), "maxGradient": float(np.max(np.abs(fit.jac)))},
           "greenAdvantageElo": advantage, "interim": current, "existingDisplayed": old,
           "targetTierGroups": tier_details, "interimRatingTierCounts": actual_tiers,
           "limitations": ["Batch is ongoing; these are interim estimates and do not replace displayed ratings.",
                           "Mean 1500 is an identification convention, not empirical evidence of a bell curve.",
                           "Normality tests are descriptive: a fixed roster and ratings estimated from shared opponents are not independent samples.",
                           "Logical clock games, not server-capacity or human-rating validation.",
                           "RD is a diagonal information approximation, not a full covariance confidence interval."]}
(OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
import csv
with (OUT / "interim-ratings.csv").open("w", encoding="utf-8-sig", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["id", "name", "targetTier", "skillPosition", "interimRating", "approxRd", "trainGames", "existingDisplayedRating"])
    for i, p in enumerate(roster):
        writer.writerow([p["id"], p["name"], p["cognition"]["targetTier"], p["cognition"]["skillPosition"], round(float(elo[i]), 2),
                         round(float(rd[i]), 1), int(counts[i]), deployed[i]])

font = Path("C:/Windows/Fonts/malgun.ttf")
if font.exists():
    font_manager.fontManager.addfont(str(font))
    plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(font)).get_name()
plt.rcParams.update({"axes.unicode_minus": False, "font.size": 10.5, "axes.titleweight": "bold",
                     "axes.spines.top": False, "axes.spines.right": False, "axes.edgecolor": "#c9d3da",
                     "axes.labelcolor": "#344451", "xtick.color": "#526370", "ytick.color": "#526370",
                     "savefig.facecolor": "white"})
teal, orange, gray = "#167d8d", "#e1852b", "#8396a5"
fig, axes = plt.subplots(2, 2, figsize=(14, 10.5))
fig.subplots_adjust(left=.075, right=.965, bottom=.12, top=.83, hspace=.45, wspace=.25)
fig.text(.075, .95, "AI 1,000명의 레이팅 분포", fontsize=24, weight="bold", color="#172c3a")
fig.text(.075, .909, f"{NOW:%Y.%m.%d %H:%M} KST  |  완료 {len(games):,} / 60,000판  |  중간 추정 · 운영 미반영", fontsize=12, color="#556a78")
fig.text(.075, .868, f"평균 {current['mean']:,.0f}  ·  표준편차 {current['sd']:,.1f}  ·  중앙값 {current['median']:,.1f}  ·  범위 {current['min']:,.0f}–{current['max']:,.0f}", fontsize=12, color=teal)


def histogram(ax, values, title, color):
    bins = np.arange(np.floor(values.min() / 50) * 50, np.ceil(values.max() / 50) * 50 + 51, 50)
    ax.hist(values, bins=bins, color=color, edgecolor="white", linewidth=.7, alpha=.88, label="실제 인원")
    x = np.linspace(min(bins[0], values.mean() - 3.5 * values.std()), max(bins[-1], values.mean() + 3.5 * values.std()), 500)
    ax.plot(x, stats.norm.pdf(x, values.mean(), values.std()) * n * 50, color=orange, linewidth=2.3,
            linestyle="--", label="같은 평균·표준편차의 정규곡선")
    ax.set(title=title, xlabel="레이팅", ylabel="AI 수 / 50점 구간")
    ax.grid(axis="y", alpha=.18)
    ax.set_axisbelow(True)
    ax.legend(fontsize=8.7, frameon=False, loc="upper right")


histogram(axes[0, 0], elo, "A. 대국 결과로 다시 추정한 현재 분포", teal)
axes[0, 0].text(.02, .96, f"왜도 {current['skewness']:+.2f}\n초과첨도 {current['excess_kurtosis']:+.2f}",
                transform=axes[0, 0].transAxes, va="top", fontsize=9.5, color="#344451")

ax = axes[0, 1]
theoretical = stats.norm.ppf((np.arange(1, n + 1) - .375) / (n + .25))
ordered = np.sort(elo)
ax.scatter(theoretical, ordered, s=9, alpha=.65, color=teal, rasterized=True)
ax.plot(theoretical, elo.mean() + elo.std() * theoretical, linestyle="--", color=orange, linewidth=2)
ax.set(title="B. 정규분포와 비교하는 Q–Q 플롯", xlabel="정규분포의 이론 분위수", ylabel="관측 레이팅 분위수")
ax.grid(alpha=.16)
ax.text(.03, .96, "직선에 가까울수록 정규분포와 유사\n끝부분의 휨은 꼬리 차이를 뜻함", transform=ax.transAxes,
        va="top", fontsize=9.3, color="#344451")

histogram(axes[1, 0], deployed, "C. 현재 화면에 표시되는 기존 레이팅", gray)
axes[1, 0].text(.025, .96, f"{deployed.min():,.0f}–{deployed.max():,.0f}점에 거의 균등 배치\n새 대국 결과로 보정되기 전 값",
                transform=axes[1, 0].transAxes, va="top", fontsize=9.3, color="#344451")

ax = axes[1, 1]
boxes = ax.boxplot(groups, patch_artist=True, widths=.55, showfliers=False,
                   medianprops={"color": "#172c3a", "linewidth": 1.7},
                   boxprops={"linewidth": .9, "edgecolor": teal},
                   whiskerprops={"color": teal}, capprops={"color": teal})
for box in boxes["boxes"]:
    box.set_facecolor("#d8edef")
ax.plot(np.arange(1, 7), [v.mean() for v in groups], "o-", color=orange, linewidth=1.7, markersize=4, label="구간 평균")
ax.set_xticks(np.arange(1, 7), tier_names, fontsize=9)
ax.set(title="D. 설계 목표 티어별 실제 추정 레이팅", ylabel="중간 추정 레이팅")
ax.grid(axis="y", alpha=.18)
ax.legend(frameon=False, fontsize=9, loc="upper left")

fig.text(.075, .062, f"3분 기본 대국 {len(train):,}판 사용 · AI별 {counts.min()}–{counts.max()}판 · 평균 1500은 보정 기준으로 고정", fontsize=10, color="#526370")
fig.text(.075, .034, "고정된 1,000명과 공유 대국에서 얻은 추정값입니다. 정규성 검정은 참고 지표이며, 최종 레이팅·사람 실력 분포가 아닙니다.", fontsize=9.5, color="#667b88")
fig.savefig(OUT / "rating-distribution.png", dpi=160)
fig.savefig(OUT / "rating-distribution.pdf")
plt.close(fig)
print(json.dumps({"output": str(OUT), "games": len(games), "trainGames": len(train), "perBot": summary["perBotTrainGames"],
                  "current": current, "existingDisplayed": old, "tierMeans": tier_details,
                  "tierCounts": actual_tiers, "greenAdvantageElo": advantage,
                  "iterations": int(fit.nit), "maxGradient": float(np.max(np.abs(fit.jac)))}, ensure_ascii=False, indent=2))
