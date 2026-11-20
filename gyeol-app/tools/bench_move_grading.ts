/** Reproducible grade comparison. npm run bench:grading -- [games=30] [detailed positions=12] */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ANALYSIS_VERSION, GRADING_VERSION, GRADES, analyzeGameGrades, analyzeMove, moveDisplayGrade, replayAnalysis, type MoveAnalysis, type MoveGrade } from '../packages/ai/src/index';
import { recenter, tileCount, type Player } from '../packages/core/src/index';
import { loadBrainContext } from '../packages/server/src/brain';

const requestedGames = Number(process.argv[2] ?? 30), detailedCount = Number(process.argv[3] ?? 12);
if (!Number.isInteger(requestedGames) || requestedGames < 2 || !Number.isInteger(detailedCount) || detailedCount < 0) throw new Error('Expected games >= 2 and detailed positions >= 0');
type SourceGame = { id: string; moves: number[]; initial: number[]; initialPlayer: Player };
const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: SourceGame[] };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stateKey = (board: number[], player: Player) => {
  const variants: string[] = [];
  for (const mirror of [false, true]) for (let turns = 0; turns < 4; turns++) {
    const transformed = Array(49).fill(0);
    board.forEach((v, i) => {
      if (!v) return;
      let r = Math.floor(i / 7), c = i % 7, dir = Math.abs(v) - 1;
      if (mirror) { c = 6 - c; dir = (4 - dir) % 4; }
      for (let t = 0; t < turns; t++) { [r, c] = [c, 6 - r]; dir = (dir + 1) % 4; }
      transformed[r * 7 + c] = Math.sign(v) * player * (dir + 1);
    });
    variants.push(recenter(transformed).board.join(','));
  }
  return variants.sort()[0];
};
const replay = (game: SourceGame) => replayAnalysis(game.moves, { board: game.initial, player: game.initialPlayer });
const family = (game: SourceGame) => sha(replay(game).map(p => stateKey(p.board, p.player)));
// Keep every symmetry/color-equivalent complete trajectory in one family before splitting.
const unique = [...new Map(source.games.map(game => [family(game), game])).values()];
const games = Array.from({ length: Math.min(requestedGames, unique.length) }, (_, i) => unique[Math.floor(i * unique.length / Math.min(requestedGames, unique.length))]);
const split = (game: SourceGame) => parseInt(family(game).slice(0, 8), 16) % 5 < 2 ? 'development' : 'heldout';
const developmentStates = new Set(games.filter(g => split(g) === 'development').flatMap(g => replay(g).map(p => stateKey(p.board, p.player))));
const brain = await loadBrainContext('apps/web/public', 4000);
// 'old' is the pre-version-3 scale, kept unchanged as the comparison baseline.
type OldGrade = MoveGrade | 'excellent';
const histogram = () => Object.fromEntries([...GRADES, 'excellent'].map(grade => [grade, 0])) as Record<OldGrade, number>;
const oldLossGrade = (loss: number): OldGrade => loss <= 1 ? 'best' : loss <= 3 ? 'excellent' : loss <= 10 ? 'fair' : loss <= 20 ? 'inaccuracy' : loss <= 35 ? 'mistake' : 'blunder';
const oldGrade = (move: MoveAnalysis, baseline: number): OldGrade => {
  if (move.status === 'exact') return move.grade!;
  const improving = move.candidates.filter(c => c.value > baseline + 1e-6);
  return improving.length === 1 && improving[0].action === move.played ? 'good' : oldLossGrade(move.lossPoints);
};
const rows: any[] = [], details: any[] = [];
const pool: { game: SourceGame; move: MoveAnalysis; index: number; phase: string }[] = [];
try {
  for (const game of games) {
    const start = { board: game.initial, player: game.initialPlayer };
    const positions = replayAnalysis(game.moves, start);
    brain.clearCache();
    const before = { ...brain.stats }, started = performance.now();
    // Disable endgame deadlines here so both rule sets see identical deterministic network candidates.
    const quick = await analyzeGameGrades(game.moves, brain.predict, { start, exactMs: 0 });
    const quickMs = performance.now() - started, quickExecutions = brain.stats.executions - before.executions;
    const old = histogram(), next = histogram();
    let changes = 0, overwrittenBest = 0;
    const baselineStarted = performance.now(), beforeBaseline = brain.stats.executions;
    for (const [index, move] of quick.moves.entries()) {
      if (!move || move.forced) continue;
      const pos = positions[index];
      const baseline = move.status === 'exact' ? 0 : (await brain.predict(pos.player === 1 ? pos.board : pos.board.map(v => -v))).value;
      const oldResult = oldGrade(move, baseline), newResult = moveDisplayGrade(move) as MoveGrade;
      old[oldResult]++; next[newResult]++;
      changes += oldResult !== newResult ? 1 : 0;
      overwrittenBest += oldResult === 'good' && newResult === 'best' ? 1 : 0;
    }
    rows.push({ id: game.id, split: split(game), moves: game.moves.length, quickMs: Math.round(quickMs), quickExecutions, legacyExtraParentExecutions: brain.stats.executions - beforeBaseline, legacyExtraParentMs: Math.round(performance.now() - baselineStarted), old, next, changes, overwrittenBest });
    if (split(game) === 'heldout') {
      for (const [phase, fraction] of [['early', 0.15], ['middle', 0.5], ['late', 0.9]] as const) {
        const index = Math.min(game.moves.length - 1, Math.floor(game.moves.length * fraction));
        const move = quick.moves[index];
        if (move && !move.forced && !developmentStates.has(stateKey(positions[index].board, positions[index].player))) pool.push({ game, move, index, phase });
      }
    }
    console.log(JSON.stringify({ stage: 'quick', completed: rows.length, total: games.length, id: game.id, ms: Math.round(quickMs) }));
  }
  // Round-robin phases, alternate mover colors where possible. Never choose cases based on new grades.
  const picked: typeof pool = [];
  for (let i = 0; picked.length < Math.min(detailedCount, pool.length); i++) {
    const phase = ['early', 'middle', 'late'][i % 3], player = Math.floor(i / 3) % 2 === 0 ? 1 : -1;
    const next = pool.find(p => p.phase === phase && p.move.player === player && !picked.includes(p))
      ?? pool.find(p => p.phase === phase && !picked.includes(p)) ?? pool.find(p => !picked.includes(p));
    if (next) picked.push(next);
  }
  for (const item of picked) {
    const { game, index, phase } = item, pos = replayAnalysis(game.moves, { board: game.initial, player: game.initialPlayer })[index];
    const runs: MoveAnalysis[] = [], times: number[] = [];
    for (const baseSims of [12, 24, 96]) {
      brain.clearCache(); const started = performance.now();
      runs.push(await analyzeMove(pos, game.moves[index], index + 1, brain.predict, { baseSims, exactMs: 10000, exactNodes: 1_000_000 }));
      times.push(Math.round(performance.now() - started));
    }
    const [low, doubled, reference] = runs;
    const candidateLoss = (action: number) => Math.max(0, (reference.bestValue - reference.candidates.find(c => c.action === action)!.value) * 50);
    const bestReferenceLoss = Math.min(...low.bestActions.map(candidateLoss));
    const stable = low.status === 'stable' && low.grade !== null && !low.forced;
    const initialBaselines = runs.map(move => ({ status: move.status, grade: move.grade, displayGrade: moveDisplayGrade(move), reason: move.reasonCode, lossPoints: move.lossPoints, bestActions: move.bestActions, played: move.played, candidates: move.candidates }));
    details.push({ id: game.id, ply: index + 1, player: pos.player, tiles: tileCount(pos.board), phase, budgets: [12, 24, 96], ms: times, runs: initialBaselines,
      stable, stableRetained: stable ? low.grade === doubled.grade : null,
      referenceIssue: reference.status === 'exact' ? reference.grade === 'mistake' || reference.grade === 'blunder' : reference.lossPoints > 20,
      predictedIssue: low.grade === 'mistake' || low.grade === 'blunder', bestReferenceLoss,
      heldoutNonSharedPosition: !developmentStates.has(stateKey(pos.board, pos.player)) });
    console.log(JSON.stringify({ stage: 'detailed', completed: details.length, total: picked.length, id: game.id, ply: index + 1, ms: times }));
  }
  const stable = details.filter(d => d.stable), retained = stable.filter(d => d.stableRetained);
  const estimated = details.filter(d => d.runs[0].status !== 'exact');
  const truePositives = details.filter(d => d.referenceIssue && d.predictedIssue).length;
  const falsePositives = details.filter(d => !d.referenceIssue && d.predictedIssue).length;
  const falseNegatives = details.filter(d => d.referenceIssue && !d.predictedIssue).length;
  const distribution = { old: histogram(), next: histogram() };
  for (const grade of [...GRADES, 'excellent'] as const) for (const kind of ['old', 'next'] as const) distribution[kind][grade] = rows.reduce((n, row) => n + row[kind][grade], 0);
  const percentile = (key: string, p: number) => [...rows].map(row => row[key]).sort((a, b) => a - b)[Math.max(0, Math.ceil(rows.length * p) - 1)];
  const report = {
    date: new Date().toISOString(), analysisVersion: ANALYSIS_VERSION, gradingVersion: GRADING_VERSION, node: process.version,
    model: JSON.parse(readFileSync('apps/web/public/model/model-info.json', 'utf8')).sha256,
    sourceSha256: createHash('sha256').update(readFileSync('tools/record-puzzles/source-games.json')).digest('hex'),
    conditions: 'Prepared Node/WASM model; inference cache cleared per game and detailed budget. Desktop only. Quick timing disables exact proofs for deterministic rule comparison. Legacy timing is incremental parent evaluation cost, not a full old-engine benchmark.',
    selection: 'Evenly spaced original game families; D4 board symmetries and color-equivalent complete trajectories grouped before hash-based development/heldout splitting. Thresholds were not tuned. Detailed phases and colors chosen without looking at grades; positions shared with development under any symmetry excluded from detailed cases. No new-game generalization claim.',
    quick: { games: rows.length, moves: rows.reduce((n, r) => n + r.moves, 0), eligible: Object.values(distribution.next).reduce((a, b) => a + b, 0), distribution, p50Ms: percentile('quickMs', 0.5), p95Ms: percentile('quickMs', 0.95), overwrittenBestCorrected: rows.reduce((n, r) => n + r.overwrittenBest, 0) },
    detailed: { cases: details.length, estimated: estimated.length, solved: details.length - estimated.length, stable: stable.length, retained: retained.length, retention: stable.length ? retained.length / stable.length : null, target: 0.95,
      coverage: estimated.length ? stable.length / estimated.length : null, truePositives, falsePositives, falseNegatives,
      provisional: estimated.length - stable.length,
      provisionalDisplayRetained: estimated.filter(d => d.runs[0].displayGrade === d.runs[1].displayGrade).length,
      solvedRetained: details.filter(d => d.runs[0].status === 'exact' && d.runs[0].grade === d.runs[1].grade).length,
      referenceMajorIssues: details.filter(d => d.referenceIssue).length, targetValidated: false,
      note: 'Small descriptive sample; the stability denominator excludes solved endgames. No stable estimated samples or no reference major mistakes means the respective metric cannot be evaluated. Higher-budget search is not a proof. Provisional decisions are abstentions. System load is not controlled. User comprehension and Android device tests require separate validation.' },
    games: rows, positions: details,
  };
  mkdirSync('tools/analysis/grading-v3', { recursive: true });
  writeFileSync('tools/analysis/grading-v3/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ quick: report.quick, detailed: report.detailed }));
} finally { await brain.dispose(); }
