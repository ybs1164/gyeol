/**
 * AI 메모리 측정: 브라우저와 같은 onnxruntime-web(wasm)을 Node에서 돌려 최강 난이도로 여러 수를 둔다.
 *   npx tsx tools/bench_memory.ts [baseline|optimized] [moves]
 * 두 모드를 서로 다른 프로세스로 실행해야 정확하다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACTION_SIZE, apply, canonical, initial, legal, result, rng, type Board, type Player } from '@gyeol/core';
import { search, type Predict } from '@gyeol/ai';
import { createPredictor, type Ort } from '../apps/web/src/ai/predictor';

const mode = process.argv[2] ?? 'optimized';
const moves = Number(process.argv[3] ?? 10);
const pub = fileURLToPath(new URL('../apps/web/public/', import.meta.url));
const ort: Ort = await import(pathToFileURL(`${pub}ort/ort.wasm.min.mjs`).href);
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = pathToFileURL(`${pub}ort/`).href;
const model = readFileSync(`${pub}model/model.onnx`);

let predict: Predict;
if (mode === 'baseline') {
  // P1 방식: 기본 세션 옵션 + 785칸 전체 정책을 최대 4만 국면까지 캐시
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  const cache = new Map<string, { priors: Float32Array; value: number; full: Float32Array }>();
  predict = async (b: Board) => {
    const key = b.join(',');
    const hit = cache.get(key);
    if (hit) return hit;
    const out = await session.run({ board: new ort.Tensor('float32', Float32Array.from(b), [1, 7, 7]) });
    const full = new Float32Array(ACTION_SIZE);
    for (let i = 0; i < ACTION_SIZE; i++) full[i] = Math.exp(out.log_policy.data[i]);
    const priors = Float32Array.from(legal(b, 1), (a) => full[a]);
    const v = { priors, value: Number(out.value.data[0]), full };
    if (cache.size > 40_000) cache.clear();
    cache.set(key, v);
    return v;
  };
} else {
  const cacheSize = Number(process.env.CACHE ?? 4000);
  predict = (await createPredictor(ort, model, cacheSize, process.env.ARENA !== '1')).predict;
}

let peakRss = 0, peakExt = 0;
const sample = () => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakExt = Math.max(peakExt, m.heapUsed + m.arrayBuffers);
};
const timer = setInterval(sample, 50);
const random = rng(1);
let b = initial();
let p: Player = 1;
const t0 = performance.now();
for (let i = 0; i < moves && !result(b, p); i++) {
  const { action } = await search(canonical(b, p), 800, predict, { random });
  b = apply(b, p, action).board;
  p = -p as Player;
  sample();
}
clearInterval(timer);
global.gc?.();
await new Promise((r) => setTimeout(r, 200));
global.gc?.();
const after = process.memoryUsage();
const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)}MB`;
console.log(JSON.stringify({ mode, moves, seconds: ((performance.now() - t0) / 1000).toFixed(1), peakRss: mb(peakRss), peakJsHeapAndBuffers: mb(peakExt), retainedJs: mb(after.heapUsed + after.arrayBuffers), endRss: mb(after.rss) }));
process.exit(0);
