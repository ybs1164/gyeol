/** 고정 AI의 새 완료 대국 수집 → 대국 단위 보정/선택/검사. 원자료부터 저장하고 재개한다. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ExactEndgame, apply, canonical, initial, legal, result, rng, tileCount, type Player } from '../packages/core/src/index';
import { fitProbability, calibratedProbability, probabilityMetrics, search, type CalibrationSample, type ProbabilityCalibration } from '../packages/ai/src/index';
import { loadBrain } from '../packages/server/src/brain';

const count = Number(process.argv[2] ?? 128);
if (!Number.isInteger(count) || count < 20) throw new Error('At least 20 games required for a pilot');
const out = 'tools/analysis/calibration-pilot';
mkdirSync(out, { recursive: true });
const model = JSON.parse(readFileSync('apps/web/public/model/model-info.json', 'utf8')).sha256 as string;
const manifest = {
  schema: 1, model, onnx: createHash('sha256').update(readFileSync('apps/web/public/model/model.onnx')).digest('hex'),
  rule: 'facing-25-v1', seed: 2026111300, simulations: 64, cpuct: 1.5,
  policy: 'visits^(1/T); T=1 for plies 0..5, T=0.35 afterwards; exact margin max at <=3 remaining',
  evaluation: ['network', 'root-q', 'root-mean'], split: 'game-index modulo 5: 0/1/2 fit, 3 select, 4 final-test',
};
const reference = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
if (existsSync(`${out}/manifest.json`)) {
  const old = JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8'));
  if (old.reference !== reference) throw new Error('Pilot inputs changed; use a different output directory');
} else writeFileSync(`${out}/manifest.json`, JSON.stringify({ ...manifest, reference }, null, 2));
interface Sample { board: number[]; player: Player; remaining: number; network: number; q: number; mean: number }
interface Game { index: number; seed: number; winner: Player; moves: number[]; samples: Sample[] }
const games: Game[] = existsSync(`${out}/games.jsonl`) ? readFileSync(`${out}/games.jsonl`, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
const done = new Set(games.map(g => g.index));
const predict = await loadBrain('apps/web/public', 12000);
type Root = { value: number; mean: number; visits: [number, number][]; network: number };
const roots = new Map<string, Root>();
const started = performance.now();
for (let index = 0; index < count; index++) {
  if (done.has(index)) continue;
  const seed = manifest.seed + index, random = rng(seed);
  let board = initial(), player: Player = 1;
  const moves: number[] = [], samples: Sample[] = [];
  while (!result(board, player)) {
    const remaining = 25 - tileCount(board);
    let action: number;
    if (remaining <= 3) {
      const values = new ExactEndgame(1_000_000).values(board, player);
      const best = Math.max(...values.map(([, v]) => v));
      const top = values.filter(([, v]) => v === best);
      action = top[Math.floor(random() * top.length)][0];
    } else {
      const cb = canonical(board, player), key = cb.join(',');
      let root = roots.get(key);
      if (!root) {
        const network = (await predict(cb)).value;
        const found = await search(cb, manifest.simulations, predict, { details: 'none', random: () => 0 });
        root = { network, value: found.value, mean: found.meanValue, visits: [...found.visits] };
        roots.set(key, root);
        if (roots.size > 2500) roots.delete(roots.keys().next().value!);
      }
      samples.push({ board: cb, player, remaining, network: root.network, q: root.value, mean: root.mean });
      const temperature = moves.length < 6 ? 1 : 0.35;
      const weights = root.visits.map(([a, n]) => [a, n ** (1 / temperature)]);
      let pick = random() * weights.reduce((n, [, w]) => n + w, 0);
      action = weights[weights.length - 1][0];
      for (const [a, weight] of weights) { pick -= weight; if (pick <= 0) { action = a; break; } }
    }
    if (!legal(board, player).includes(action)) throw new Error('Reference generated illegal move');
    moves.push(action); board = apply(board, player, action).board; player = -player as Player;
    if (moves.length > 50) throw new Error('Reference did not terminate');
  }
  const end = result(board, player);
  if (tileCount(board) !== 25 || Math.abs(end) < 0.5) throw new Error('Standard rule invariant failed');
  const game: Game = { index, seed, winner: Math.sign(end) * player as Player, moves, samples };
  appendFileSync(`${out}/games.jsonl`, JSON.stringify(game) + '\n'); games.push(game);
  console.log(JSON.stringify({ games: games.length, target: count, seconds: Math.round((performance.now() - started) / 1000) }));
}

const seenFitAndSelect = new Set(games.filter(g => g.index % 5 !== 4).flatMap(g => g.samples.map(s => s.board.join(','))));
const datasets = (field: 'network' | 'q' | 'mean', split: 'fit' | 'select' | 'test', novelOnly = false): CalibrationSample[] => games
  .filter(g => split === 'fit' ? g.index % 5 < 3 : g.index % 5 === (split === 'select' ? 3 : 4))
  .flatMap(g => g.samples.filter(s => !novelOnly || !seenFitAndSelect.has(s.board.join(','))).map(s => ({ value: s[field], remaining: s.remaining, won: (g.winner === s.player ? 1 : 0) as 0 | 1, game: String(g.index) })));
function confidence(rows: CalibrationSample[], predict: (s: CalibrationSample) => number) {
  const byGame = new Map<string, CalibrationSample[]>();
  for (const s of rows) { const group = byGame.get(s.game) ?? []; group.push(s); byGame.set(s.game, group); }
  const groups = [...byGame.values()];
  if (!groups.length) return null;
  const random = rng(20261113);
  const briers: number[] = [], losses: number[] = [];
  const gaps: number[][] = Array.from({ length: 10 }, () => []);
  for (let trial = 0; trial < 500; trial++) {
    let brier = 0, loss = 0;
    const bins = Array.from({ length: 10 }, () => ({ n: 0, expected: 0, won: 0 }));
    for (let i = 0; i < groups.length; i++) {
      const group = groups[Math.floor(random() * groups.length)];
      for (const s of group) {
        const p = Math.max(1e-5, Math.min(1 - 1e-5, predict(s)));
        brier += (p - s.won) ** 2 / group.length / groups.length;
        loss -= (s.won ? Math.log(p) : Math.log(1 - p)) / group.length / groups.length;
        const bin = bins[Math.min(9, Math.floor(p * 10))]; bin.n++; bin.expected += p; bin.won += s.won;
      }
    }
    briers.push(brier); losses.push(loss);
    bins.forEach((b, i) => { if (b.n) gaps[i].push((b.won - b.expected) / b.n); });
  }
  const interval = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values.length ? [values[Math.floor(values.length * 0.025)], values[Math.min(values.length - 1, Math.floor(values.length * 0.975))]] : null;
  };
  return { method: '500 bootstrap resamples of whole independent games', brier95: interval(briers), logLoss95: interval(losses), calibrationGap95: gaps.map(interval) };
}
const candidates = (['network', 'q', 'mean'] as const).map(field => {
  const fit = datasets(field, 'fit'), select = datasets(field, 'select'), test = datasets(field, 'test');
  const coefficients = fitProbability(fit);
  const evaluate = (rows: CalibrationSample[]) => ({
    raw: probabilityMetrics(rows, s => (s.value + 1) / 2),
    calibrated: probabilityMetrics(rows, s => calibratedProbability(s.value, s.remaining, coefficients)),
    constant: probabilityMetrics(rows, () => fit.reduce((n, s) => n + s.won, 0) / fit.length),
  });
  const calibration: ProbabilityCalibration = {
    version: `${reference.slice(0, 12)}-${field}`, model: model.slice(0, 16), rule: manifest.rule,
    evaluator: field === 'network' ? 'network' : field === 'q' ? 'root-q' : 'root-mean',
    simulations: field === 'network' ? 0 : 64, reference,
    accepted: false, // pilot는 대국 단위 불확실성·미지 국면 검사를 끝내지 않았으므로 자동 배포하지 않는다.
    coefficients, validationGames: new Set(test.map(s => s.game)).size, remainingRange: [4, 23],
  };
  return { field, calibration, fitGames: new Set(fit.map(s => s.game)).size, selection: evaluate(select), finalTest: evaluate(test),
    novelPositionTest: { definition: 'Canonical board not present in fitting or selection games; no augmentation was generated.', ...evaluate(datasets(field, 'test', true)) },
    finalTestConfidence: confidence(test, s => calibratedProbability(s.value, s.remaining, coefficients)),
  };
});
const selection = [...candidates].filter(c => c.field !== 'network').sort((a, b) => a.selection.calibrated.brier! - b.selection.calibrated.brier!)[0].field;
writeFileSync(`${out}/report.json`, JSON.stringify({ reference, games: games.length, selectedOnSelectionSplit: selection, accepted: false,
  inferenceNormalization: 'Clamp finite tanh values within 1e-6 of [-1,1]; reject larger deviations. Existing first 90 completed games passed the stricter range guard.',
  reason: 'Pilot only. Require independent-game uncertainty, novel-position evaluation and sufficient validation games before deployment.', candidates }, null, 2));
writeFileSync(`${out}/candidates.json`, JSON.stringify(candidates.map(c => c.calibration), null, 2));
console.log(JSON.stringify({ games: games.length, selection, report: `${out}/report.json`, accepted: false }));
