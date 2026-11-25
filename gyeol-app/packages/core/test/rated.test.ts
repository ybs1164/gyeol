import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PUZZLE_STAGES, apply, bestReply, captureCounts, correctMoves, distinctWinningBoards, legal, loadPuzzleBank, loadedPuzzles,
  pickRated, ratedBank, ratedPuzzle, puzzleValues, ratingDelta, result, stageBand, stageOf, uniqueProofProblem, bruteForceProblem, keepPuzzleProblem,
  migratePuzzleRating, recommendedPuzzleRating, PUZZLE_SCALE, puzzleStartForGame, type Board, type Player, type PuzzleBankFile,
} from '../src';

/** 서버 생성기(db-cli mine-puzzles)가 보관 기보에서 만든 은행 일부. 실제 운영 은행은 서버가 내려준다. */
const fixture = JSON.parse(readFileSync(new URL('./puzzle-bank.fixture.json', import.meta.url), 'utf8')) as PuzzleBankFile;
loadPuzzleBank(fixture);

describe('서버가 내려주는 정답 하나짜리 퍼즐', () => {
  const bank = ratedBank();
  /** 상대 응수와 종국까지 두는 수순 문제 */
  const lines = () => bank.filter((e) => ratedPuzzle(e.id)!.format !== 'move');
  const keeps = () => bank.filter((e) => ratedPuzzle(e.id)!.format === 'move');
  test('받은 은행만 쓰고, 정답이 하나라는 조건을 어긴 문제는 버린다', () => {
    expect(bank.length).toBe(fixture.puzzles.length);
    expect(new Set(bank.map((p) => p.id)).size).toBe(bank.length);
    expect(bank.every((p) => p.id.startsWith('rp-') && ['advantage', 'turnaround', 'win', 'keep'].includes(p.kind))).toBe(true);
    expect(ratedPuzzle('f-1')).toBeNull();
    const broken = structuredClone(fixture);
    for (const v of broken.puzzles[0].proof[0][1]) v[1] = 3;
    expect(uniqueProofProblem(broken.puzzles[0])).toBe('not-unique');
    expect(loadPuzzleBank(broken)).toBe(fixture.puzzles.length - 1);
    expect(() => loadPuzzleBank({ ...fixture, schema: 2 as 1 })).toThrow();
    loadPuzzleBank(fixture);
    expect(loadedPuzzles().length).toBe(fixture.puzzles.length);
  });
  test('모든 단계에 문제가 있고 선택한 단계 밖으로 새지 않는다', () => {
    for (const stage of PUZZLE_STAGES) {
      const [lo, hi] = stageBand(stage);
      expect(bank.filter((p) => p.rating >= lo && p.rating < hi).length).toBeGreaterThanOrEqual(1);
      for (const seen of [new Set<string>(), new Set(bank.map((p) => p.id))]) {
        for (const target of [-10000, 1500, 10000]) {
          const p = pickRated(target, seen, () => 0.5, stage.n);
          expect(p.rating).toBeGreaterThanOrEqual(lo);
          expect(p.rating).toBeLessThan(hi);
        }
      }
    }
  });
  test('보관 기보에서 나온 문제는 판·차례·실제 수가 원본 수순과 일치하고, 실제로 둔 수가 유일한 정답이다', () => {
    const sources = JSON.parse(readFileSync(new URL('../../../tools/record-puzzles/source-games.json', import.meta.url), 'utf8')) as {
      games: { id: string; initial: Board; initialPlayer: Player; moves: number[] }[];
    };
    for (const e of bank) {
      const p = ratedPuzzle(e.id)!;
      if (p.format === 'move') continue;
      const game = sources.games.find((g) => g.id === p.source.gameId)!;
      expect(game, p.id).toBeDefined();
      let b = game.initial, turn = game.initialPlayer;
      for (const a of game.moves.slice(0, p.source.ply)) { expect(legal(b, turn)).toContain(a); b = apply(b, turn, a).board; turn = -turn as Player; }
      expect(b, p.id).toEqual(p.board);
      expect(turn).toBe(p.player);
      expect(game.moves[p.source.ply]).toBe(p.source.playedMove);
      const wins = correctMoves(p.kind, puzzleValues(p, b, turn));
      expect(new Set(wins.map((a) => apply(b, turn, a).board.join(','))).size).toBe(1);
      expect(wins).toContain(p.source.playedMove);
    }
  });
  test('어느 최선 응수 뒤에서도 이기는 수는 하나뿐이고, 끝까지 두면 실제 승리하며 한 수짜리 문제는 없다', () => {
    for (const e of lines()) {
      const p = ratedPuzzle(e.id)!;
      const root = puzzleValues(p, p.board, p.player);
      const wins = correctMoves(p.kind, root);
      expect(distinctWinningBoards(p.board, p.player, root), p.id).toBe(1);
      expect(new Set(legal(p.board, p.player).map((a) => apply(p.board, p.player, a).board.join(','))).size).toBeGreaterThanOrEqual(3);
      for (const a of wins) expect(result(apply(p.board, p.player, a).board, -p.player as Player), p.id).toBe(0);
      const visited = new Set<string>();
      let lines = 0;
      const walk = (b: Board, turn: Player, depth: number) => {
        expect(depth).toBeLessThanOrEqual(2 * (25 - p.board.filter(Boolean).length) + 1);
        if (result(b, turn)) { expect(result(b, p.player), p.id).toBe(1); lines++; return; }
        const key = `${turn}:${b.join(',')}`;
        if (visited.has(key)) return;
        visited.add(key);
        const values = puzzleValues(p, b, turn);
        let actions: number[];
        if (turn === p.player) {
          expect(distinctWinningBoards(b, turn, values), p.id).toBe(1);
          actions = correctMoves(p.kind, values).slice(0, 1);
        } else {
          const best = Math.max(...values.values());
          actions = [...values].filter(([, v]) => v === best).map(([a]) => a);
          expect(actions).toContain(bestReply(p, b, turn));
        }
        for (const a of actions) { expect(legal(b, turn)).toContain(a); walk(apply(b, turn, a).board, -turn as Player, depth + 1); }
      };
      walk(p.board, p.player, 0);
      expect(lines).toBeGreaterThan(0);
    }
  });
  test('저장된 값은 가지치기 없는 전수 탐색과 같다', () => {
    for (const p of [...loadedPuzzles()].filter((q) => q.format !== 'move').sort((a, b) => a.solverNodes - b.solverNodes).slice(0, 4)) expect(bruteForceProblem(p), p.id).toBeNull();
  });
  test('모든 오답에도 실제로 막는 응수가 준비돼 있다', () => {
    for (const e of lines()) {
      const p = ratedPuzzle(e.id)!;
      for (const [a, value] of puzzleValues(p, p.board, p.player)) {
        if (value > 0) continue;
        const b = apply(p.board, p.player, a).board;
        const opp = -p.player as Player;
        if (!result(b, opp)) {
          const reply = bestReply(p, b, opp);
          expect(legal(b, opp)).toContain(reply);
          expect(puzzleValues(p, b, opp).get(reply)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
  test('가장 많이 먹는 수가 실패하는 실전 전술 문제가 포함돼 있다', () => {
    const traps = bank.filter((e) => {
      const p = ratedPuzzle(e.id)!;
      const captures = captureCounts(p.board, p.player);
      const max = Math.max(...captures.values());
      const values = puzzleValues(p, p.board, p.player);
      return [...captures].filter(([, n]) => n === max).every(([a]) => values.get(a)! <= 0);
    });
    expect(traps.length).toBeGreaterThan(0);
  });
  test('한 수 문제: 유리함(강제 승리)을 지키는 수가 하나뿐이고, 원본 기보 국면이며, 전수 탐색과 일치한다', () => {
    const sources = JSON.parse(readFileSync(new URL('../../../tools/record-puzzles/source-games.json', import.meta.url), 'utf8')) as {
      games: { id: string; initial: Board; initialPlayer: Player; moves: number[] }[];
    };
    expect(keeps().length).toBeGreaterThan(0);
    for (const e of keeps()) {
      const p = ratedPuzzle(e.id)!;
      expect(p.kind).toBe('keep');
      expect(p.judge).toBe('exact');
      expect(keepPuzzleProblem(p), p.id).toBeNull();
      const root = puzzleValues(p, p.board, p.player);
      expect(distinctWinningBoards(p.board, p.player, root)).toBe(1);
      expect([...root.values()].filter((v) => v <= 0).length).toBeGreaterThanOrEqual(2);
      const game = sources.games.find((g) => g.id === p.source.gameId)!;
      let b = game.initial, turn = game.initialPlayer;
      for (const a of game.moves.slice(0, p.source.ply)) { b = apply(b, turn, a).board; turn = -turn as Player; }
      expect(b).toEqual(p.board);
      if (25 - p.board.filter(Boolean).length <= 6) expect(bruteForceProblem(p), p.id).toBeNull();
      // 평가를 바꿔 승리 수가 둘이 되면 은행에서 버린다
      const broken = { ...p, evals: p.evals!.map(([a]) => [a, 1] as [number, number]) };
      expect(keepPuzzleProblem(broken)).not.toBeNull();
    }
  });
  test('풀이 증명이 없을 때 추정이나 무작위 수로 대체하지 않는다', () => {
    const p = ratedPuzzle(bank[0].id)!;
    expect(() => puzzleValues({ ...p, proof: [] }, p.board, p.player)).toThrow();
  });
});

describe('퍼즐 레이팅', () => {
  test('어려운 문제를 맞힐수록 더 오르고 처음에는 크게 조정한다', () => {
    expect(ratingDelta(1500, 1500, true, 30)).toBeGreaterThan(0);
    expect(ratingDelta(1500, 1500, false, 30)).toBeLessThan(0);
    expect(ratingDelta(1500, 1800, true, 30)).toBeGreaterThan(ratingDelta(1500, 1200, true, 30));
    expect(ratingDelta(1500, 1500, true, 0)).toBeGreaterThan(ratingDelta(1500, 1500, true, 50));
  });
  test('현재 AI 척도와 기존 기록 변환을 유지한다', () => {
    expect(stageOf(1135).n).toBe(1);
    expect(stageOf(1136).n).toBe(2);
    expect(migratePuzzleRating(650)).toBe(1136);
    expect(migratePuzzleRating(1150)).toBe(1483);
    expect(migratePuzzleRating(2150)).toBe(2207);
    const target = recommendedPuzzleRating(1800, () => 0.5);
    expect(1 / (1 + 10 ** ((target - 1800) / 400))).toBeCloseTo(0.65, 2);
    expect(puzzleStartForGame(1900, 5)).toBe(1900);
    expect(puzzleStartForGame(1900, 4)).toBe(PUZZLE_SCALE.start);
  });
});
