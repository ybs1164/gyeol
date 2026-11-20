/**
 * P2: P1이 내보낸 국면에 정답 라벨을 붙인다(서버에서 실행).
 *   npx tsx tools/learning/relabel.ts --in <export 폴더> --out <labels 폴더>
 *     [--model apps/web/public/model/model.onnx] [--sims 800] [--workers 2] [--budget-minutes 0] [--max 0]
 *
 * - 남은 타일이 적은 국면부터 처리한다(정확 라벨이 싸고 가장 확실하다). --budget-minutes 가 지나면 새 국면을 시작하지 않는다.
 * - 작업자는 라벨을 하나 만들 때마다 조각 파일에 덧붙인다. 중간에 멈춰도 다음 실행이 조각을 먼저 합친다.
 * - 같은 국면(대칭 키)은 한 번만 라벨한다. 상태: <out>/labeled-keys.txt, <out>/label-state.json
 * - 결과: <out>/labels-<실행 번호>-<시각>.jsonl (packages/ai/src/training-labels.ts 의 TrainingLabel + key)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPredictor, labelPosition, LABEL_DEFAULTS, TRAINING_LABEL_VERSION, type Ort } from '../../packages/ai/src/index';
import { symmetryKey, type Board, type Player } from '../../packages/core/src/index';

interface Position { board: Board; player: Player; remaining: number }
interface Todo extends Position { key: string }
interface State { version: number; runs: number; labeled: number; byTier: Record<string, number>; models: Record<string, number> }

const self = fileURLToPath(import.meta.url);
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  if (i > 0) return process.argv[i + 1];
  if (fallback === undefined) throw new Error(`${name} is required`);
  return fallback;
};
const num = (name: string, fallback: number) => { const n = Number(arg(name, String(fallback))); if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be >= 0`); return n; };
const digest = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const out = resolve(arg('--out', ''));
const modelPath = resolve(arg('--model', 'apps/web/public/model/model.onnx'));
const sims = num('--sims', LABEL_DEFAULTS.sims);
const todoFile = join(out, '.todo.jsonl');
const partFile = (i: number) => join(out, `.part-${i}.jsonl`);

function writePrivate(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}
function loadState(): State {
  const file = join(out, 'label-state.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: TRAINING_LABEL_VERSION, runs: 0, labeled: 0, byTier: {}, models: {} };
}

/** 조각 파일을 labels 파일 하나로 합치고 키·상태를 갱신한다. 이전 실행이 남긴 조각에도 쓴다. */
function mergeParts(state: State, labeledKeys: Set<string>): { file: string | null; count: number } {
  const parts = readdirSync(out).filter(f => /^\.part-\d+\.jsonl$/.test(f));
  const lines: string[] = [], keys: string[] = [];
  for (const part of parts) {
    for (const line of readFileSync(join(out, part), 'utf8').split('\n')) {
      if (!line) continue;
      let row: { key: string; tier: string; search: { model: string } | null };
      try { row = JSON.parse(line); } catch { continue; } // 강제 종료로 잘린 마지막 줄
      if (labeledKeys.has(row.key)) continue;
      labeledKeys.add(row.key); keys.push(row.key); lines.push(line);
      state.byTier[row.tier] = (state.byTier[row.tier] ?? 0) + 1;
      if (row.search) state.models[row.search.model] = (state.models[row.search.model] ?? 0) + 1;
    }
  }
  let file: string | null = null;
  if (lines.length) {
    state.runs++; state.labeled += lines.length;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    file = join(out, `labels-${String(state.runs).padStart(6, '0')}-${stamp}.jsonl`);
    writePrivate(file, lines.join('\n') + '\n');
    appendFileSync(join(out, 'labeled-keys.txt'), keys.join('\n') + '\n', { mode: 0o600 });
  }
  writePrivate(join(out, 'label-state.json'), JSON.stringify(state, null, 2) + '\n');
  for (const part of parts) rmSync(join(out, part));
  return { file, count: lines.length };
}

async function worker(index: number, workers: number, deadline: number) {
  const ortDir = resolve('apps/web/public/ort');
  const ort: Ort = await import(pathToFileURL(join(ortDir, 'ort.wasm.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(ortDir + '/').href;
  const bytes = readFileSync(modelPath);
  const model = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const brain = await createPredictor(ort, bytes, 50_000);
  const todo = readFileSync(todoFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Todo);
  for (let k = index; k < todo.length; k += workers) {
    if (deadline && Date.now() > deadline) break;
    const t = todo[k];
    const label = await labelPosition(t.board, t.player, brain.predict, { model, sims });
    appendFileSync(partFile(index), JSON.stringify({ key: t.key, ...label }) + '\n');
  }
  await brain.dispose();
}

const workerArg = process.argv.indexOf('--worker');
if (workerArg > 0) {
  const [i, n] = process.argv[workerArg + 1].split('/').map(Number);
  await worker(i, n, Number(arg('--deadline', '0')));
} else {
  const input = resolve(arg('--in'));
  const workers = Math.max(1, num('--workers', 2)), budget = num('--budget-minutes', 0), max = num('--max', 0);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const state = loadState();
  if (state.version !== TRAINING_LABEL_VERSION) throw new Error(`Label state version ${state.version} differs from ${TRAINING_LABEL_VERSION}`);
  const keyFile = join(out, 'labeled-keys.txt');
  const labeledKeys = new Set(existsSync(keyFile) ? readFileSync(keyFile, 'utf8').split('\n').filter(Boolean) : []);
  const recovered = mergeParts(state, labeledKeys);
  if (recovered.count) console.log(`recovered ${recovered.count} labels from an interrupted run → ${recovered.file}`);

  const started = Date.now(), seen = new Set<string>();
  const todo: Todo[] = [];
  for (const f of readdirSync(input).filter(f => /^positions-.*\.jsonl$/.test(f)).sort()) {
    for (const line of readFileSync(join(input, f), 'utf8').split('\n').filter(Boolean)) {
      const p = JSON.parse(line) as Position;
      const key = digest(symmetryKey(p.board, p.player));
      if (labeledKeys.has(key) || seen.has(key)) continue;
      seen.add(key); todo.push({ key, board: p.board, player: p.player, remaining: p.remaining });
    }
  }
  todo.sort((a, b) => a.remaining - b.remaining); // 정확 라벨부터
  const batch = max ? todo.slice(0, max) : todo;
  if (!batch.length) { console.log(JSON.stringify({ pending: 0, labeled: state.labeled, byTier: state.byTier })); process.exit(0); }
  writePrivate(todoFile, batch.map(t => JSON.stringify(t)).join('\n') + '\n');
  const deadline = budget ? started + budget * 60_000 : 0;
  console.log(`labeling ${batch.length} of ${todo.length} pending positions with ${workers} workers, ${sims} sims${budget ? `, ${budget} min budget` : ''}`);
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [...process.execArgv, self, '--worker', `${i}/${workers}`, '--out', out, '--model', modelPath, '--sims', String(sims), '--deadline', String(deadline)], { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? done() : fail(new Error(`worker ${i} exited ${code}`)));
  })));
  const merged = mergeParts(state, labeledKeys);
  rmSync(todoFile);
  console.log(JSON.stringify({ file: merged.file, labeled: merged.count, pending: todo.length - merged.count, seconds: Math.round((Date.now() - started) / 1000), total: state.labeled, byTier: state.byTier, models: state.models }, null, 2));
}
