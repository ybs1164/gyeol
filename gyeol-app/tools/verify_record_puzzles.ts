/** 생성기와 달리 알파베타·휴리스틱·깊이 제한 없이 모든 수를 열거하는 독립 검사. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { apply, legal, margin, result, type Board, type Player } from '../packages/core/src/rules';
import type { RecordPuzzleData } from '../packages/core/src/record-types';

const sourceText = readFileSync('tools/record-puzzles/source-games.json', 'utf8');
const sources = JSON.parse(sourceText) as { games: { id: string; initial: Board; initialPlayer: Player; moves: number[] }[] };
const candidates = JSON.parse(readFileSync('tools/record-puzzles/candidates.json', 'utf8')) as RecordPuzzleData[];
const accepted: RecordPuzzleData[] = [];
const skipped: string[] = [];
let checkedStates = 0;
for (const puzzle of candidates) {
  let nodes = 0;
  const memo = new Map<string, number>();
  const brute = (board: Board, player: Player): number => {
    const key = `${player}:${board.join(',')}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (++nodes > 3_000_000) throw new Error('verification-budget');
    const value = result(board, player) ? margin(board) * player
      : Math.max(...legal(board, player).map((a) => -brute(apply(board, player, a).board, -player as Player)));
    memo.set(key, value);
    return value;
  };
  const positionKey = (b: Board, p: Player) => b.map((v) => String(v * p + 5)).join('');
  try {
    const game = sources.games.find((g) => g.id === puzzle.source.gameId);
    assert.ok(game, 'missing source');
    let board = game.initial, player = game.initialPlayer;
    for (const a of game.moves.slice(0, puzzle.source.ply)) { board = apply(board, player, a).board; player = -player as Player; }
    assert.deepEqual(board, puzzle.board, 'source board mismatch');
    assert.equal(player, puzzle.player);
    assert.equal(game.moves[puzzle.source.ply], puzzle.source.playedMove);
    const proof = new Map(puzzle.proof);
    assert.equal(proof.size, puzzle.proof.length, 'duplicate proof nodes');
    for (const [key, values] of proof) {
      const b = [...key].map((v) => Number(v) - 5);
      assert.equal(b.length, 49);
      assert.equal(result(b, 1), 0, 'terminal proof node');
      assert.deepEqual(values.map(([a]) => a), legal(b, 1), 'missing or extra actions');
      for (const [action, value] of values) assert.equal(-brute(apply(b, 1, action).board, -1), value, `wrong value ${puzzle.id}/${action}`);
    }
    const root = proof.get(positionKey(puzzle.board, puzzle.player))!;
    assert.ok(root);
    const wins = root.filter(([, v]) => v > 0);
    assert.ok(wins.length && wins.length < root.length);
    assert.ok(wins.some(([a]) => a === puzzle.source.playedMove));
    assert.equal(Math.min(...wins.map(([, v]) => v)), puzzle.guaranteedMargin);
    const visited = new Set<string>();
    let terminalLines = 0;
    const walk = (b: Board, p: Player, depth: number) => {
      assert.ok(depth <= 2 * (25 - puzzle.board.filter(Boolean).length) + 1);
      if (result(b, p)) { assert.equal(result(b, puzzle.player), 1, 'non-winning accepted line'); terminalLines++; return; }
      const key = positionKey(b, p);
      const visit = `${p}:${key}`;
      if (visited.has(visit)) return;
      visited.add(visit);
      const values = proof.get(key);
      assert.ok(values, 'incomplete playable proof');
      if (p === puzzle.player) {
        for (const [a, v] of values) {
          const child = apply(b, p, a).board;
          if (v > 0) walk(child, -p as Player, depth + 1);
          else if (!result(child, -p as Player)) assert.ok(proof.has(positionKey(child, -p as Player)), 'missing wrong-move reply');
        }
      } else {
        const best = Math.max(...values.map(([, v]) => v));
        walk(apply(b, p, values.find(([, v]) => v === best)![0]).board, -p as Player, depth + 1);
      }
    };
    walk(puzzle.board, puzzle.player, 0);
    assert.ok(terminalLines > 0);
    checkedStates += nodes;
    accepted.push(puzzle);
  } catch (error) {
    if (error instanceof Error && error.message === 'verification-budget') skipped.push(puzzle.id);
    else throw error;
  }
  if ((accepted.length + skipped.length) % 20 === 0) console.log(`${accepted.length} independently verified; ${skipped.length} excluded`);
}
assert.ok(accepted.length >= 16, 'Too few verified puzzles');
writeFileSync('tools/record-puzzles/verified.json', JSON.stringify(accepted));
const report = { verifiedAt: new Date().toISOString(), sourceGames: sources.games.length, candidates: candidates.length,
  verified: accepted.length, excludedByBudget: skipped, independentlyCheckedStates: checkedStates,
  sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
  puzzleSha256: createHash('sha256').update(JSON.stringify(accepted)).digest('hex'),
  method: 'Independent exhaustive terminal minimax; every stored action value, every playable winning branch, every wrong-move reply, and original recorded prefix checked; no heuristic leaves.' };
writeFileSync('tools/record-puzzles/verification-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
