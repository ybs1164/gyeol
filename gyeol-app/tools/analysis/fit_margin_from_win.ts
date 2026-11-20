/**
 * 승률 그래프 값(p)과 남은 타일 수(r)로 최종 타일 차이를 추정하는 식을 고른다.
 * 표본: calibration-pilot 128판(64회 탐색 root-mean). 화면과 같게 1:2:1 이웃 평균을 적용한 p를 쓴다.
 * 분할: 대국 번호 mod 5 → 0/1/2 적합, 3 선택, 4 최종 시험(manifest와 같음).
 *   npx tsx tools/analysis/fit_margin_from_win.ts
 */
import { readFileSync } from 'node:fs';
import { apply, initial, margin, type Player } from '../../packages/core/src/index';

interface Sample { player: Player; remaining: number; mean: number }
interface Game { index: number; moves: number[]; samples: Sample[] }
const games = readFileSync('tools/analysis/calibration-pilot/games.jsonl', 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s) as Game);

/** 표준 정규분포 누적분포의 역함수(Acklam 근사). */
function probit(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -probit(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

interface Row { game: number; r: number; p: number; m: number }
const rows: Row[] = [];
for (const g of games) {
  let pos = { board: initial(), player: 1 as Player };
  for (const a of g.moves) { const next = apply(pos.board, pos.player, a); pos = { board: next.board, player: -pos.player as Player }; }
  const finalGreen = margin(pos.board);
  // 초록 기준 승률, 화면과 같은 1:2:1 평균
  const green = g.samples.map(s => s.player === 1 ? (s.mean + 1) / 2 : (1 - s.mean) / 2);
  g.samples.forEach((s, i) => {
    const before = green[i - 1], after = green[i + 1];
    const p = before !== undefined && after !== undefined ? (before + 2 * green[i] + after) / 4 : before !== undefined ? (before + green[i]) / 2 : after !== undefined ? (green[i] + after) / 2 : green[i];
    rows.push({ game: g.index, r: s.remaining, p, m: finalGreen });
  });
}
const split = (k: number[]) => rows.filter(x => k.includes(x.game % 5));
const fit = split([0, 1, 2]), select = split([3]), test = split([4]);

const EPS = [0.01, 0.02, 0.05];
type Model = { name: string; feature: (p: number) => number; scale: (r: number, w: number[]) => number; params: number };
const models: Model[] = [
  { name: 'linear v, k=a', feature: p => 2 * p - 1, scale: (_r, w) => w[0], params: 1 },
  { name: 'linear v, k=a+b·r', feature: p => 2 * p - 1, scale: (r, w) => w[0] + w[1] * r, params: 2 },
  { name: 'linear v, k=a·√r', feature: p => 2 * p - 1, scale: (r, w) => w[0] * Math.sqrt(r), params: 1 },
  ...EPS.flatMap(e => [
    { name: `probit ε=${e}, k=a`, feature: (p: number) => probit(Math.min(1 - e, Math.max(e, p))), scale: (_r: number, w: number[]) => w[0], params: 1 },
    { name: `probit ε=${e}, k=a+b·r`, feature: (p: number) => probit(Math.min(1 - e, Math.max(e, p))), scale: (r: number, w: number[]) => w[0] + w[1] * r, params: 2 },
    { name: `probit ε=${e}, k=a·√r`, feature: (p: number) => probit(Math.min(1 - e, Math.max(e, p))), scale: (r: number, w: number[]) => w[0] * Math.sqrt(r), params: 1 },
  ]),
];
/** m ≈ k(r)·f(p) 가 w 에 선형이므로 최소제곱 정규방정식으로 푼다. */
function solve(model: Model, data: Row[]): number[] {
  const n = model.params;
  const basis = (x: Row) => Array.from({ length: n }, (_, j) => { const w = Array(n).fill(0); w[j] = 1; return model.scale(x.r, w) * model.feature(x.p); });
  const A = Array.from({ length: n }, () => Array(n).fill(0)), y = Array(n).fill(0);
  for (const x of data) { const f = basis(x); for (let i = 0; i < n; i++) { y[i] += f[i] * x.m; for (let j = 0; j < n; j++) A[i][j] += f[i] * f[j]; } }
  if (n === 1) return [y[0] / A[0][0]];
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  return [(y[0] * A[1][1] - y[1] * A[0][1]) / det, (A[0][0] * y[1] - A[1][0] * y[0]) / det];
}
const clampM = (v: number) => Math.max(-25, Math.min(25, v));
const err = (model: Model, w: number[], data: Row[]) => {
  let se = 0, ae = 0, sign = 0, signN = 0;
  for (const x of data) {
    const e = clampM(model.scale(x.r, w) * model.feature(x.p)) - x.m; se += e * e; ae += Math.abs(e);
    const pred = Math.round(clampM(model.scale(x.r, w) * model.feature(x.p)));
    if (x.m !== 0 && pred !== 0) { signN++; if (Math.sign(pred) === Math.sign(x.m)) sign++; }
  }
  return { rmse: Math.sqrt(se / data.length), mae: ae / data.length, sign: sign / Math.max(1, signN) };
};
const baseline = { rmse: Math.sqrt(select.reduce((s, x) => s + x.m * x.m, 0) / select.length), mae: select.reduce((s, x) => s + Math.abs(x.m), 0) / select.length };
console.log(`rows: fit ${fit.length}, select ${select.length}, test ${test.length}; baseline(0) select rmse ${baseline.rmse.toFixed(2)} mae ${baseline.mae.toFixed(2)}`);
const results = models.map(model => { const w = solve(model, fit); return { model, w, sel: err(model, w, select) }; }).sort((a, b) => a.sel.rmse - b.sel.rmse);
for (const r of results) console.log(`${r.model.name.padEnd(24)} w=${r.w.map(v => v.toFixed(4)).join(',').padEnd(18)} select rmse ${r.sel.rmse.toFixed(2)} mae ${r.sel.mae.toFixed(2)} sign ${(100 * r.sel.sign).toFixed(0)}%`);
const best = results[0];
const refit = solve(best.model, [...fit, ...select]);
const final = err(best.model, refit, test);
console.log(`\nselected: ${best.model.name}; refit on fit+select w=${refit.map(v => v.toFixed(4)).join(',')}`);
console.log(`final test rmse ${final.rmse.toFixed(2)} mae ${final.mae.toFixed(2)} sign ${(100 * final.sign).toFixed(0)}%  (baseline rmse ${Math.sqrt(test.reduce((s, x) => s + x.m * x.m, 0) / test.length).toFixed(2)})`);
console.log('\nby remaining (test): r | n | mae');
for (let r = 23; r >= 4; r--) { const d = test.filter(x => x.r === r); if (d.length) console.log(`${String(r).padStart(2)} | ${String(d.length).padStart(3)} | ${err(best.model, refit, d).mae.toFixed(2)}`); }
