import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { RecordPuzzleData } from '../packages/core/src/record-types';
import { syncPuzzleScale } from './puzzle_scale';
import { apply, result } from '../packages/core/src/rules';
import { positionKey } from '../packages/core/src/endgame';

export function publishRecordPuzzles() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = `${root}tools/record-puzzles/`;
  const verifiedText = readFileSync(`${dir}verified.json`, 'utf8');
  const report = JSON.parse(readFileSync(`${dir}verification-report.json`, 'utf8'));
  const ruleReport = JSON.parse(readFileSync(`${dir}rule-check-report.json`, 'utf8'));
  assert.ok(ruleReport.passed);
  assert.equal(ruleReport.puzzleSha256, report.puzzleSha256, 'Rule check is stale');
  assert.equal(createHash('sha256').update(verifiedText).digest('hex'), report.puzzleSha256, 'Verified data changed');
  assert.equal(createHash('sha256').update(readFileSync(`${dir}source-games.json`)).digest('hex'), report.sourceSha256, 'Source records changed');
  const verified = JSON.parse(verifiedText) as RecordPuzzleData[];
  assert.equal(verified.length, report.verified);
  const scale = syncPuzzleScale();
  // 한 수로 바로 끝나는 장수 세기와 유사한 문제는 출제하지 않는다.
  const eligible = verified.filter((p) => new Map(p.proof).get(positionKey(p.board, p.player))!
    .filter(([, v]) => v > 0).every(([a]) => !result(apply(p.board, p.player, a).board, -p.player as 1 | -1)));
  assert.ok(eligible.length >= 16);
  const sorted = [...eligible].sort((a, b) => a.raw - b.raw || a.id.localeCompare(b.id));
  const bank = sorted.map((p, i) => {
    const pos = ((i + 0.5) / sorted.length) * 8;
    const stage = Math.min(7, Math.floor(pos));
    const lo = scale.stageFloors[stage], hi = scale.stageFloors[stage + 1] ?? scale.puzzleMax;
    return { ...p, rating: Math.min(hi - 1, Math.round(lo + (pos - stage) * (hi - lo))) };
  });
  const metadata = { verified: true, sourceGames: report.sourceGames, puzzles: bank.length,
    sha256: createHash('sha256').update(JSON.stringify(bank)).digest('hex'), verificationSha256: report.puzzleSha256 };
  writeFileSync(`${root}packages/core/src/record-puzzle-bank.ts`, '// 자동 생성: npm run puzzles. 실전 기보의 종국까지 검증한 승리 퍼즐만 수록.\n' +
    "import type { RecordPuzzleData } from './record-types';\n" +
    'export const RECORD_PUZZLES: RecordPuzzleData[] = ' + JSON.stringify(bank) + ';\n' +
    'export const RECORD_BANK_VERIFICATION = ' + JSON.stringify(metadata) + ';\n');
  const greedyTraps = bank.filter((p) => {
    const values = new Map(p.proof).get(positionKey(p.board, p.player))!;
    const moves = values.map(([a, v]) => ({ v, flips: apply(p.board, p.player, a).last.flipped?.length ?? 0 }));
    const max = Math.max(...moves.map((m) => m.flips));
    return moves.filter((m) => m.flips === max).every((m) => m.v <= 0);
  }).length;
  const published = { ...report, ruleChecks: ruleReport, publishedPuzzles: bank.length,
    excludedImmediateFinishes: verified.length - bank.length, greedyTraps,
    publishedAt: new Date().toISOString(), kinds: Object.fromEntries(['advantage', 'turnaround', 'win'].map((k) => [k, bank.filter((p) => p.kind === k).length])),
    stages: scale.stageFloors.map((lo, i) => ({ n: i + 1, lo, hi: scale.stageFloors[i + 1] ?? scale.puzzleMax,
      count: bank.filter((p) => p.rating >= lo && p.rating < (scale.stageFloors[i + 1] ?? scale.puzzleMax)).length })),
    difficultyMethod: 'Estimated difficulty from remaining moves, legal alternatives and search work; aligned to current AI anchors. Winning claims independently verified to terminal states.' };
  writeFileSync(`${dir}bank-report.json`, JSON.stringify(published, null, 2));
  writeFileSync(`${dir}puzzles.csv`, '\ufeffid,kind,rating,gameId,moveNumber,guaranteedMargin\n' + bank.map((p) => `${p.id},${p.kind},${p.rating},${p.source.gameId},${p.source.moveNumber},${p.guaranteedMargin}`).join('\n') + '\n');
  console.log(JSON.stringify(published, null, 2));
}
