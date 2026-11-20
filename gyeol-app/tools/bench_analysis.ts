/** 실제 배포 모델로 기존 1-ply와 신규 후반 분석을 고정 기보에서 비교한다. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { apply, canonical, initial, legal, result, type Player, type RecordPuzzleData } from '../packages/core/src/index';
import { ANALYSIS_VERSION, analyzeGame, terminalValue, type GameAnalysis } from '../packages/ai/src/index';
import { loadBrain } from '../packages/server/src/brain';

const sources = JSON.parse(readFileSync('tools/record-puzzles/source-games.json', 'utf8')) as { games: { initial: number[]; initialPlayer: Player; moves: number[]; id: string }[] };
const puzzles = JSON.parse(readFileSync('tools/record-puzzles/verified.json', 'utf8')) as RecordPuzzleData[];
const predict = await loadBrain('apps/web/public');
const report: Record<string, unknown> = { date: new Date().toISOString(), node: process.version, engine: ANALYSIS_VERSION, config: { mode: 'standard', minimumSimulations: 12, contenderSimulations: 96, exactNodes: 100000, exactMilliseconds: 350 }, model: JSON.parse(readFileSync('apps/web/public/model/model-info.json', 'utf8')).sha256 };
const fixtureCount = Number(process.argv[2] ?? 200);
let candidates = 0, baselineOutcomeErrors = 0, newOutcomeErrors = 0, exact = 0, missed = 0;
const cases: unknown[] = [];
for (const p of puzzles.filter(p => p.board.filter(Boolean).length >= 22).slice(0, fixtureCount)) {
  const truth = new Map(p.proof[0][1]);
  const losing = p.proof[0][1].find(([, v]) => v < 0)?.[0] ?? p.source.playedMove;
  const started = performance.now();
  const a = await analyzeGame([losing], predict, { start: p });
  const m = a.moves[0]!;
  for (const c of m.candidates) {
    const child = apply(p.board, p.player, c.action).board;
    const turn = -p.player as Player, end = result(child, turn);
    const oldQ = end ? -terminalValue(end) : -(await predict(canonical(child, turn))).value;
    const correct = Math.sign(truth.get(c.action)!);
    baselineOutcomeErrors += Math.sign(oldQ) !== correct ? 1 : 0;
    newOutcomeErrors += Math.sign(c.value) !== correct ? 1 : 0;
    candidates++;
  }
  exact += m.status === 'exact' ? 1 : 0;
  missed += m.badges.includes('missedWin') ? 1 : 0;
  cases.push({ puzzle: p.id, milliseconds: Math.round(performance.now() - started), status: m.status, grade: m.grade, candidates: m.candidates.length });
}
report.endgame = { cases: cases.length, candidates, baselineOutcomeErrors, newOutcomeErrors, exact, missed, details: cases, note: '선택된 후반 퍼즐 표본. 일반 대국 전체의 정확도를 대표하지 않는다.' };
const game = sources.games.find(g => JSON.stringify(g.initial) === JSON.stringify(initial()) && g.initialPlayer === 1)!;
if (!game) throw new Error('No standard opening record');
const start = performance.now();
let firstResultMs: number | undefined;
let firstMoveMs: number | undefined;
let last: GameAnalysis | undefined;
const a = await analyzeGame(game.moves, predict, { onProgress: partial => {
  firstResultMs ??= performance.now() - start;
  if (partial.moves.some(Boolean)) firstMoveMs ??= performance.now() - start;
  last = partial;
  console.log(JSON.stringify({ completed: partial.moves.filter(Boolean).length, total: game.moves.length, ms: Math.round(performance.now() - start) }));
} });
report.fullGame = {
  source: game.id, moves: game.moves.length, firstResultMs: Math.round(firstResultMs!), firstMoveMs: Math.round(firstMoveMs!), totalMs: Math.round(performance.now() - start),
  exact: a.moves.filter(m => m?.status === 'exact').length, graded: a.moves.filter(m => m?.grade).length,
  pending: a.moves.filter(m => m && !m.grade && !m.forced).length,
  allPositions: last?.positions.every(Boolean),
};
mkdirSync('tools/analysis', { recursive: true });
writeFileSync('tools/analysis/benchmark.json', JSON.stringify(report, null, 2));
writeFileSync('tools/analysis/sample-game.json', JSON.stringify({ record: { ...game, id: 'analysis-check', mode: 'local', me: null, date: Date.now(), winner: 1 }, analysis: a }));
console.log(JSON.stringify({ report: 'tools/analysis/benchmark.json', endgame: { cases: cases.length, candidates, baselineOutcomeErrors, newOutcomeErrors, exact }, fullGame: report.fullGame }, null, 2));
