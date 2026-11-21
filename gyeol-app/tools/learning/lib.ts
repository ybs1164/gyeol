/** 지속 학습 도구 공통: 임의 ONNX 모델 불러오기, 얼린 시험 세트 채점. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPredictor, expectedMargin, search, type Ort } from '../../packages/ai/src/index';
import { canonical, type Board, type Player } from '../../packages/core/src/index';

/** 채점 보고서 폴더. 서버에서는 저장소가 읽기 전용이라 LEARNING_REPORTS 로 데이터 폴더를 가리킨다. */
export const REPORTS_DIR = process.env.LEARNING_REPORTS ?? 'tools/learning/reports';
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** 앱과 같은 onnxruntime-web(wasm, 1스레드)으로 모델을 연다. */
export async function loadModel(modelPath: string, cacheSize = 50_000) {
  const bytes = readFileSync(modelPath);
  const ortDir = resolve('apps/web/public/ort');
  const ort: Ort = await import(pathToFileURL(join(ortDir, 'ort.wasm.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(ortDir + '/').href;
  const brain = await createPredictor(ort, bytes, cacheSize);
  return { ...brain, path: resolve(modelPath), bytes: bytes.length, sha: sha256(bytes) };
}
export type LoadedModel = Awaited<ReturnType<typeof loadModel>>;

interface Row { id: string; remaining: number; player: Player; board: Board; outcome: -1 | 0 | 1; margin: number | null }
type Scored = { r: number; p: number; outcome: number; margin: number | null; head?: number };

function mean(v: number[]) { return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); }
function round(v: number) { return Math.round(v * 10000) / 10000; }

export function metrics(xs: Scored[]) {
  const decisive = xs.filter(x => x.outcome !== 0);
  const correct = decisive.filter(x => x.p !== 0.5 && Math.sign(x.p - 0.5) === x.outcome).length;
  const y = (x: Scored) => (x.outcome + 1) / 2;
  const clip = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
  const withMargin = xs.filter(x => x.margin !== null);
  const withHead = withMargin.filter(x => x.head !== undefined);
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
    // 모델의 타일 차이 출력(있을 때만)
    marginHeadMae: withHead.length ? round(mean(withHead.map(x => Math.abs(x.head! - x.margin!)))) : null,
    bins,
  };
}
export type Metrics = ReturnType<typeof metrics>;
export interface ScoreReport {
  set: string; setSha256: string; model: { path: string; onnxSha256: string; info: unknown };
  sims: number; evaluator: string; created: string; seconds: number;
  network: { all: Metrics; byRemaining: Record<string, Partial<Metrics>> };
  search: { all: Metrics; byRemaining: Record<string, Partial<Metrics>> };
}

/**
 * 얼린 시험 세트로 채점한다(같은 입력이면 같은 숫자). reports/<set>-<onnx sha 16>-s<sims>.json 에 저장하고,
 * 같은 파일이 이미 있으면 다시 계산하지 않는다(fresh = true 면 다시 계산).
 */
export async function scoreModel(modelPath: string, { sims = 64, set = 'exact-test-v1', fresh = false, log = console.log } = {}): Promise<{ report: ScoreReport; file: string }> {
  const manifest = JSON.parse(readFileSync(`tools/learning/frozen/${set}.manifest.json`, 'utf8'));
  if (sha256(readFileSync(manifest.file.path)) !== manifest.file.sha256) throw new Error(`${set} changed after it was frozen`);
  const onnxSha = sha256(readFileSync(modelPath));
  const file = join(REPORTS_DIR, `${set}-${onnxSha.slice(0, 16)}-s${sims}.json`);
  if (!fresh && existsSync(file)) return { report: JSON.parse(readFileSync(file, 'utf8')), file };
  const rows = readFileSync(manifest.file.path, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s) as Row);
  const brain = await loadModel(modelPath);
  const scored: Record<'network' | 'search', Scored[]> = { network: [], search: [] };
  const started = performance.now();
  for (const [k, row] of rows.entries()) {
    const canon = canonical(row.board, row.player);
    const toGreen = (v: number) => row.player === 1 ? (v + 1) / 2 : (1 - v) / 2;
    const prediction = await brain.predict(canon);
    // 타일 차이 출력은 둘 차례 기준 → 초록 기준
    const head = prediction.margin === undefined ? undefined : prediction.margin * row.player;
    const root = await search(canon, sims, brain.predict, { details: 'none', random: () => 0 });
    scored.network.push({ r: row.remaining, p: toGreen(prediction.value), outcome: row.outcome, margin: row.margin, head });
    scored.search.push({ r: row.remaining, p: toGreen(root.meanValue), outcome: row.outcome, margin: row.margin });
    if ((k + 1) % 500 === 0) log(`  scored ${k + 1} / ${rows.length} (${Math.round((performance.now() - started) / 1000)}s)`);
  }
  await brain.dispose();
  const byRemaining = (xs: Scored[]) => Object.fromEntries([...new Set(xs.map(x => x.r))].sort((a, b) => a - b).map(r => {
    const m = metrics(xs.filter(x => x.r === r));
    return [r, { n: m.n, accuracy: m.accuracy, brier: m.brier, ece: m.ece, marginMae: m.marginMae, marginHeadMae: m.marginHeadMae }];
  }));
  const infoPath = join(dirname(resolve(modelPath)), 'model-info.json');
  const report: ScoreReport = {
    set, setSha256: manifest.file.sha256,
    model: { path: resolve(modelPath).replaceAll('\\', '/'), onnxSha256: onnxSha, info: existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf8')) : null },
    sims, evaluator: 'root-mean', created: new Date().toISOString(), seconds: Math.round((performance.now() - started) / 1000),
    network: { all: metrics(scored.network), byRemaining: byRemaining(scored.network) },
    search: { all: metrics(scored.search), byRemaining: byRemaining(scored.search) },
  };
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return { report, file };
}

export const formatMetrics = (name: string, m: Metrics) =>
  `${name.padEnd(10)} acc ${(100 * m.accuracy).toFixed(1)}%  brier ${m.brier.toFixed(3)}  logloss ${m.logLoss.toFixed(3)}  ece ${m.ece.toFixed(3)}  marginMAE ${m.marginMae} (zero ${m.marginMaeZero}${m.marginHeadMae == null ? '' : `, head ${m.marginHeadMae}`})`;
