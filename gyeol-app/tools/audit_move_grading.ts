/** Recheck raw grades against the saved, higher-budget search comparison.
 * node --import tsx tools/audit_move_grading.ts
 * This audits existing samples; it does not fit thresholds or claim accuracy.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { analyzeGameGrades, gradeMove, replayAnalysis, type MoveAnalysis } from '../packages/ai/src/index';
import { type Player } from '../packages/core/src/index';
import { loadBrainContext } from '../packages/server/src/brain';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const saved = read('tools/analysis/grading-v3/report.json');
const info = read('apps/web/public/model/model-info.json');
assert.equal(saved.model, info.sha256, 'Saved search used a different model');
const sourcePath = 'tools/record-puzzles/source-games.json';
const source = read(sourcePath) as { games: { id: string; moves: number[]; initial: number[]; initialPlayer: Player }[] };
if (saved.sourceSha256) assert.equal(saved.sourceSha256, createHash('sha256').update(readFileSync(sourcePath)).digest('hex'));
const sixGrade = (loss: number) => loss <= 2 ? 'best' : loss <= 5 ? 'good' : loss <= 10 ? 'fair' : loss <= 20 ? 'inaccuracy' : loss <= 35 ? 'mistake' : 'blunder';
const brain = await loadBrainContext('apps/web/public');
const rows: any[] = [];
try {
  for (const sample of saved.positions) {
    const game = source.games.find(g => g.id === sample.id)!;
    assert.ok(game, 'Missing source game');
    const index = sample.ply - 1;
    const pos = replayAnalysis(game.moves, { board: game.initial, player: game.initialPlayer })[index];
    const before = performance.now();
    const quick = await analyzeGameGrades([game.moves[index]], brain.predict, { start: pos, exactMs: 0 });
    const actual = quick.moves[0]!;
    const runs = sample.runs as (MoveAnalysis & { displayGrade?: string })[];
    const reference = runs[2];
    const estimated = reference.status !== 'exact';
    rows.push({
      id: sample.id, ply: sample.ply, phase: sample.phase, player: pos.player,
      raw: { loss: actual.lossPoints, grade: actual.grade ?? actual.provisionalGrade, ms: Math.round(performance.now() - before) },
      search: runs.map(r => ({ status: r.status, grade: r.grade ?? r.provisionalGrade ?? r.displayGrade, loss: r.lossPoints })),
      proposedSix: estimated ? runs.map(r => sixGrade(r.lossPoints)) : null,
      rawMatchesReference: estimated ? gradeMove(actual.lossPoints) === gradeMove(reference.lossPoints) : null,
      rawLossDifference: estimated ? Math.abs(actual.lossPoints - reference.lossPoints) : null,
      rawMajorFalseAlarm: estimated ? actual.lossPoints > 20 && reference.lossPoints <= 20 : null,
    });
    console.log(JSON.stringify({ done: rows.length, total: saved.positions.length, id: sample.id, ply: sample.ply }));
  }
} finally { await brain.dispose(); }
const estimated = rows.filter(r => r.proposedSix);
const report = {
  date: new Date().toISOString(), model: info.sha256,
  reference: { path: 'tools/analysis/grading-v3/report.json', sha256: createHash('sha256').update(readFileSync('tools/analysis/grading-v3/report.json')).digest('hex'), budgets: [12, 24, 96], candidateSimulationMultipliers: [1, 4, 8] },
  limits: 'Twelve existing selected positions, eight with estimated search references. Higher-budget search is not ground truth. The six-grade table is an illustrative proposal, not fitted, shipped, or validated. This does not establish tactical-error precision/recall or mobile latency.',
  estimated: {
    count: estimated.length,
    rawMatchesReference: estimated.filter(r => r.rawMatchesReference).length,
    rawMajorFalseAlarms: estimated.filter(r => r.rawMajorFalseAlarm).length,
    meanAbsoluteRawLossDifference: estimated.reduce((n, r) => n + r.rawLossDifference, 0) / estimated.length,
    sevenGradeLowToDoubleRetained: estimated.filter(r => r.search[0].grade === r.search[1].grade).length,
    sixGradeLowToDoubleRetained: estimated.filter(r => r.proposedSix[0] === r.proposedSix[1]).length,
    sevenGradeLowToReferenceRetained: estimated.filter(r => r.search[0].grade === r.search[2].grade).length,
    sixGradeLowToReferenceRetained: estimated.filter(r => r.proposedSix[0] === r.proposedSix[2]).length,
  }, rows,
};
mkdirSync('tools/analysis/grading-audit', { recursive: true });
writeFileSync('tools/analysis/grading-audit/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.estimated));
