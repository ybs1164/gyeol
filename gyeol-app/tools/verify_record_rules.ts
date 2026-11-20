import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { apply, result } from '../packages/core/src/rules';
import { positionKey } from '../packages/core/src/endgame';
import type { RecordPuzzleData } from '../packages/core/src/record-types';

const text = readFileSync('tools/record-puzzles/verified.json', 'utf8');
const puzzles = JSON.parse(text) as RecordPuzzleData[];
const hash = createHash('sha256').update(text).digest('hex');
const seen = new Map<string, [number, string, number][]>();
for (const puzzle of puzzles) for (const [key, values] of puzzle.proof) {
  if (seen.has(key)) continue;
  const board = [...key].map((v) => Number(v) - 5);
  seen.set(key, values.map(([a]) => {
    const child = apply(board, 1, a).board;
    return [a, positionKey(child, -1), result(child, -1)];
  }));
}
const verified = spawnSync('python', ['tools/verify_record_rules.py'], {
  input: JSON.stringify({ puzzleSha256: hash, states: [...seen] }), encoding: 'utf8', maxBuffer: 20_000_000,
});
if (verified.stdout) process.stdout.write(verified.stdout);
assert.equal(verified.status, 0, verified.stderr);
