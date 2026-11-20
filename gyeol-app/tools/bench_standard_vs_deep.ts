/**
 * 일반 분석(빠른 등급) 설정을 정밀 분석 결과와 비교한다.
 *   npx tsx tools/bench_standard_vs_deep.ts reference <i>   i번째 대국의 정밀 분석 기준을 만든다(대국마다 따로, 병렬 실행 가능)
 *   npx tsx tools/bench_standard_vs_deep.ts compare [설정...]  저장된 기준과 일반 분석 후보 설정들을 비교한다
 * 대국: 최강 AI 자가 대국 1판 + 기록 대국 앞 7판.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyzeGameGrades, gameReport, type AnalysisOptions, type GameAnalysis } from '../packages/ai/src/index';
import type { Player } from '../packages/core/src/index';
import { loadBrainContext } from '../packages/server/src/brain';

const OUT = 'tools/analysis/standard-vs-deep';
mkdirSync(OUT, { recursive: true });
type Game = { id: string; moves: number[]; start?: { board: number[]; player: Player } };
const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { id: string; moves: number[]; initial: number[]; initialPlayer: Player }[] };
const GAMES: Game[] = [
  { id: 'master-vs-master', moves: [389, 368, 392, 378, 390, 408, 301, 289, 310, 298, 414, 426, 542, 538, 358, 478, 647, 624, 589, 631, 515, 496, 784, 465] },
  ...source.games.slice(0, 7).map(g => ({ id: g.id, moves: g.moves, start: { board: g.initial, player: g.initialPlayer } })),
];
const [command, index] = process.argv.slice(2);
const brain = await loadBrainContext('apps/web/public', 100_000);

if (command === 'reference') {
  const game = GAMES[Number(index)];
  const t = performance.now();
  const deep = await analyzeGameGrades(game.moves, brain.predict, { start: game.start, mode: 'deep' });
  writeFileSync(`${OUT}/deep-${game.id}.json`, JSON.stringify({ ms: Math.round(performance.now() - t), analysis: deep }));
  console.log(JSON.stringify({ game: game.id, moves: game.moves.length, seconds: Math.round((performance.now() - t) / 1000) }));
} else if (command === 'compare') {
  const variants: Record<string, AnalysisOptions> = {
    current: {},
    exact7: { gradeExactRemaining: 7, exactNodes: 400_000, exactMs: 600 },
    exact8: { gradeExactRemaining: 8, exactNodes: 1_000_000, exactMs: 1500 },
    focus16: { focusSims: 16 },
    focus32: { focusSims: 32 },
    focus8: { focusSims: 8 },
    'exact8+focus8': { gradeExactRemaining: 8, exactNodes: 1_000_000, exactMs: 1500, focusSims: 8 },
    'exact8+focus16': { gradeExactRemaining: 8, exactNodes: 1_000_000, exactMs: 1500, focusSims: 16 },
    'exact8+focus32': { gradeExactRemaining: 8, exactNodes: 1_000_000, exactMs: 1500, focusSims: 32 },
  };
  // 뒤에 설정 이름을 주면 그것만 비교한다: compare current focus16
  const only = process.argv.slice(3);
  for (const name of Object.keys(variants)) if (only.length && !only.includes(name)) delete variants[name];
  const refs = GAMES.filter(g => existsSync(`${OUT}/deep-${g.id}.json`)).map(g => ({ game: g, ...JSON.parse(readFileSync(`${OUT}/deep-${g.id}.json`, 'utf8')) as { ms: number; analysis: GameAnalysis } }));
  console.log(`references: ${refs.length} games, deep avg ${Math.round(refs.reduce((n, r) => n + r.ms, 0) / refs.length / 1000)}s per game`);
  const rows: Record<string, unknown>[] = [];
  for (const [name, options] of Object.entries(variants)) {
    let ms = 0, moves = 0, lossDiff = 0, bestAgree = 0, accDiff = 0, sides = 0, exact = 0;
    for (const ref of refs) {
      brain.clearCache(); // 대국마다 추론 캐시를 비워 시간 비교를 공정하게
      const t = performance.now();
      const a = await analyzeGameGrades(ref.game.moves, brain.predict, { start: ref.game.start, mode: 'standard', ...options });
      ms += performance.now() - t;
      a.moves.forEach((m, i) => {
        const d = ref.analysis.moves[i]!;
        if (!m || m.forced || d.forced) return;
        moves++; lossDiff += Math.abs(m.lossPoints - d.lossPoints);
        if (m.bestActions.includes(m.played) === d.bestActions.includes(d.played)) bestAgree++;
        if (m.status === 'exact') exact++;
      });
      for (const p of [1, -1] as const) {
        const x = gameReport(a, p).accuracy, y = gameReport(ref.analysis, p).accuracy;
        if (x !== null && y !== null) { accDiff += Math.abs(x - y); sides++; }
      }
    }
    const row = { variant: name, secondsPerGame: +(ms / refs.length / 1000).toFixed(1), accuracyGap: +(accDiff / sides).toFixed(1), bestAgreement: +(100 * bestAgree / moves).toFixed(1), meanLossGap: +(lossDiff / moves).toFixed(1), exactMoves: exact };
    rows.push(row); console.log(JSON.stringify(row));
  }
  writeFileSync(`${OUT}/report-${only.length ? only.join('+') : 'all'}.json`, JSON.stringify({ date: new Date().toISOString(), games: refs.map(r => r.game.id), note: 'Node, one model session, inference cache cleared per game. Gaps are against deep (정밀) grades of the same build.', rows }, null, 2));
}
await brain.dispose();
