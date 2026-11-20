import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeWinProbability, WIN_ANALYSIS_VERSION, WIN_ROOT_EVALUATOR, ROOT_SIMULATIONS } from '../packages/ai/src/index';
import type { Player } from '../packages/core/src/index';
import { loadBrainContext } from '../packages/server/src/brain';

const count = Number(process.argv[2] ?? 30);
const source = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { id: string; moves: number[]; initial: number[]; initialPlayer: Player }[] };
const games = [...new Map(source.games.map(g => [JSON.stringify([g.initial, g.initialPlayer, g.moves]), g])).values()].slice(0, count);
const loadStart = performance.now();
const brain = await loadBrainContext('apps/web/public', 4000);
const loadMs = performance.now() - loadStart;
const cases: { id: string; moves: number; previewMs: number; totalMs: number; executions: number; hits: number; inferenceMs: number; simulations: number; exact: number }[] = [];
for (const game of games) {
  brain.clearCache(); // 대국별 추론 캐시는 비우고 모델 세션만 준비된 조건을 고정한다.
  const before = { ...brain.stats };
  const graph = await analyzeWinProbability(game.moves, brain.predict, { start: { board: game.initial, player: game.initialPlayer } });
  const row = {
    id: game.id, moves: game.moves.length, previewMs: Math.round(graph.metrics.previewMs!), totalMs: Math.round(graph.metrics.totalMs),
    executions: brain.stats.executions - before.executions, hits: brain.stats.cacheHits - before.cacheHits,
    inferenceMs: Math.round(brain.stats.inferenceMs - before.inferenceMs), simulations: graph.metrics.simulations,
    exact: graph.positions.filter(p => p?.status === 'exact').length,
  };
  cases.push(row); console.log(JSON.stringify({ completed: cases.length, target: games.length, ...row }));
}
const percentile = (key: 'totalMs' | 'previewMs', fraction: number) => [...cases].sort((a, b) => a[key] - b[key])[Math.max(0, Math.ceil(cases.length * fraction) - 1)][key];
const report = {
  date: new Date().toISOString(), node: process.version, model: JSON.parse(readFileSync('apps/web/public/model/model-info.json', 'utf8')).sha256,
  condition: 'Node WASM, one prepared model session; prediction cache cleared before every game; not Android; not cold browser startup',
  version: WIN_ANALYSIS_VERSION, evaluator: WIN_ROOT_EVALUATOR, budget: ROOT_SIMULATIONS.standard, games: games.length, loadMs: Math.round(loadMs),
  preview: { p50: percentile('previewMs', 0.5), p95: percentile('previewMs', 0.95) },
  complete: { p50: percentile('totalMs', 0.5), p95: percentile('totalMs', 0.95) },
  baseline: JSON.parse(readFileSync('tools/analysis/benchmark.json', 'utf8')).fullGame,
  cases,
};
writeFileSync('tools/analysis/win-speed-report.json', JSON.stringify(report, null, 2));
await brain.dispose();
console.log(JSON.stringify({ loadMs: report.loadMs, games: report.games, preview: report.preview, complete: report.complete }));
