/**
 * P0/P4: 모델 하나를 얼린 정확 시험 세트로 채점한다. 같은 입력이면 같은 숫자가 나온다(탐색 난수 고정).
 *   npx tsx tools/learning/score_model.ts [--model apps/web/public/model/model.onnx] [--sims 64] [--set exact-test-v1]
 * 결과: tools/learning/reports/<set>-<onnx sha 16>-s<sims>.json
 * 지표(초록 기준 승률 p): 승패 적중률(무승부 제외), Brier, log loss, 10구간 보정, 예상 타일 차이 평균 오차(expectedMargin).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPredictor, expectedMargin, search, type Ort } from '../../packages/ai/src/index';
import { canonical, type Board, type Player } from '../../packages/core/src/index';

interface Row { id: string; remaining: number; player: Player; board: Board; outcome: -1 | 0 | 1; margin: number | null }
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const modelPath = resolve(arg('--model', 'apps/web/public/model/model.onnx'));
const sims = Number(arg('--sims', '64'));
const set = arg('--set', 'exact-test-v1');
const rows = readFileSync(`tools/learning/frozen/${set}.jsonl`, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s) as Row);
const manifest = JSON.parse(readFileSync(`tools/learning/frozen/${set}.manifest.json`, 'utf8'));
const bytes = readFileSync(modelPath);
const onnxSha = createHash('sha256').update(bytes).digest('hex');
if (createHash('sha256').update(readFileSync(manifest.file.path)).digest('hex') !== manifest.file.sha256) throw new Error(`${set} changed after it was frozen`);

const ortDir = resolve('apps/web/public/ort');
const ort: Ort = await import(pathToFileURL(join(ortDir, 'ort.wasm.min.mjs')).href);
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = pathToFileURL(ortDir + '/').href;
const brain = await createPredictor(ort, bytes, 50_000);

type Scored = { r: number; p: number; outcome: number; margin: number | null };
const scored: Record<'network' | 'search', Scored[]> = { network: [], search: [] };
const started = performance.now();
for (const [k, row] of rows.entries()) {
  const canon = canonical(row.board, row.player);
  const toGreen = (v: number) => row.player === 1 ? (v + 1) / 2 : (1 - v) / 2;
  const net = (await brain.predict(canon)).value;
  const root = await search(canon, sims, brain.predict, { details: 'none', random: () => 0 });
  scored.network.push({ r: row.remaining, p: toGreen(net), outcome: row.outcome, margin: row.margin });
  scored.search.push({ r: row.remaining, p: toGreen(root.meanValue), outcome: row.outcome, margin: row.margin });
  if ((k + 1) % 200 === 0) console.log(`${k + 1} / ${rows.length} (${Math.round((performance.now() - started) / 1000)}s)`);
}
await brain.dispose?.();

function metrics(xs: Scored[]) {
  const decisive = xs.filter(x => x.outcome !== 0);
  const correct = decisive.filter(x => x.p !== 0.5 && Math.sign(x.p - 0.5) === x.outcome).length;
  const y = (x: Scored) => (x.outcome + 1) / 2;
  const clip = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
  const withMargin = xs.filter(x => x.margin !== null);
  const bins = Array.from({ length: 10 }, (_, i) => {
    const b = xs.filter(x => Math.min(9, Math.floor(x.p * 10)) === i);
    return { from: i / 10, to: (i + 1) / 10, n: b.length, predicted: b.length ? round(mean(b.map(x => x.p))) : null, observed: b.length ? round(mean(b.map(y))) : null };
  });
  return {
    n: xs.length, draws: xs.length - decisive.length,
    accuracy: round(correct / Math.max(1, decisive.length)),
    brier: round(mean(xs.map(x => (x.p - y(x)) ** 2))),
    logLoss: round(mean(xs.map(x => -(y(x) * Math.log(clip(x.p)) + (1 - y(x)) * Math.log(1 - clip(x.p)))))),
    // 보정 오차: 구간별 |예측 평균 − 실제 비율|의 표본 가중 평균
    ece: round(bins.reduce((s, b) => s + (b.n ? b.n * Math.abs(b.predicted! - b.observed!) : 0), 0) / Math.max(1, xs.length)),
    marginN: withMargin.length,
    marginMae: withMargin.length ? round(mean(withMargin.map(x => Math.abs(expectedMargin(x.p) - x.margin!)))) : null,
    marginMaeZero: withMargin.length ? round(mean(withMargin.map(x => Math.abs(x.margin!)))) : null,
    bins,
  };
}
function mean(v: number[]) { return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); }
function round(v: number) { return Math.round(v * 10000) / 10000; }

const byRemaining = (xs: Scored[]) => Object.fromEntries([...new Set(xs.map(x => x.r))].sort((a, b) => a - b).map(r => {
  const m = metrics(xs.filter(x => x.r === r)); return [r, { n: m.n, accuracy: m.accuracy, brier: m.brier, ece: m.ece, marginMae: m.marginMae }];
}));
const infoPath = join(dirname(modelPath), 'model-info.json');
const report = {
  set, setSha256: manifest.file.sha256, model: { path: modelPath.replaceAll('\\', '/'), onnxSha256: onnxSha, info: existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf8')) : null },
  sims, evaluator: 'root-mean', created: new Date().toISOString(), seconds: Math.round((performance.now() - started) / 1000),
  network: { all: metrics(scored.network), byRemaining: byRemaining(scored.network) },
  search: { all: metrics(scored.search), byRemaining: byRemaining(scored.search) },
};
mkdirSync('tools/learning/reports', { recursive: true });
const out = `tools/learning/reports/${set}-${onnxSha.slice(0, 16)}-s${sims}.json`;
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const line = (name: string, m: ReturnType<typeof metrics>) => console.log(`${name.padEnd(10)} acc ${(100 * m.accuracy).toFixed(1)}%  brier ${m.brier.toFixed(3)}  logloss ${m.logLoss.toFixed(3)}  ece ${m.ece.toFixed(3)}  marginMAE ${m.marginMae} (zero ${m.marginMaeZero})`);
line('network', report.network.all); line(`search${sims}`, report.search.all);
console.log(`wrote ${out}`);
