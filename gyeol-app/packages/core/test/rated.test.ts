import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  PUZZLE_STAGES, RECORD_BANK_VERIFICATION, apply, bestReply, captureCounts, correctMoves, legal,
  pickRated, ratedBank, ratedPuzzle, puzzleValues, ratingDelta, result, stageBand, stageOf,
  migratePuzzleRating, recommendedPuzzleRating, PUZZLE_SCALE, puzzleStartForGame, type Board, type Player,
} from '../src';
import { RECORD_PUZZLES } from '../src/record-puzzle-bank';

describe('검증된 실전 퍼즐', () => {
  const bank = ratedBank();
  test('장수 목표·임의 생성 문제가 없고 배포 은행은 검증한 데이터다', () => {
    expect(bank.length).toBeGreaterThanOrEqual(64);
    expect(new Set(bank.map((p) => p.id)).size).toBe(bank.length);
    expect(bank.every((p) => p.id.startsWith('rp-') && ['advantage', 'turnaround', 'win'].includes(p.kind))).toBe(true);
    expect(RECORD_BANK_VERIFICATION.verified).toBe(true);
    expect(RECORD_BANK_VERIFICATION.puzzles).toBe(bank.length);
    expect(createHash('sha256').update(JSON.stringify(RECORD_PUZZLES)).digest('hex')).toBe(RECORD_BANK_VERIFICATION.sha256);
    expect(ratedPuzzle('f-1')).toBeNull();
  });
  test('모든 단계에 실제 검증 문제가 있고 선택한 단계 밖으로 새지 않는다', () => {
    for (const stage of PUZZLE_STAGES) {
      const [lo, hi] = stageBand(stage);
      expect(bank.filter((p) => p.rating >= lo && p.rating < hi).length).toBeGreaterThanOrEqual(8);
      for (const seen of [new Set<string>(), new Set(bank.map((p) => p.id))]) {
        for (const target of [-10000, 1500, 10000]) {
          const p = pickRated(target, seen, () => 0.5, stage.n);
          expect(p.rating).toBeGreaterThanOrEqual(lo);
          expect(p.rating).toBeLessThan(hi);
        }
      }
    }
  });
  test('전 문제의 판·차례·실제 수가 보관된 원본 기보의 해당 수순과 일치한다', () => {
    const sources = JSON.parse(readFileSync(new URL('../../../tools/record-puzzles/source-games.json', import.meta.url), 'utf8')) as {
      games: { id: string; initial: Board; initialPlayer: Player; moves: number[] }[];
    };
    for (const e of bank) {
      const p = ratedPuzzle(e.id)!;
      const game = sources.games.find((g) => g.id === p.source.gameId)!;
      expect(game, p.id).toBeDefined();
      let b = game.initial, turn = game.initialPlayer;
      for (const a of game.moves.slice(0, p.source.ply)) { expect(legal(b, turn)).toContain(a); b = apply(b, turn, a).board; turn = -turn as Player; }
      expect(b, p.id).toEqual(p.board);
      expect(turn).toBe(p.player);
      expect(game.moves[p.source.ply]).toBe(p.source.playedMove);
      expect(correctMoves(p.kind, puzzleValues(p, b, turn))).toContain(p.source.playedMove);
    }
  });
  test('모든 정답 분기를 최선 응수와 끝까지 두면 실제 승리하고 한 수짜리 문제는 없다', () => {
    for (const e of bank) {
      const p = ratedPuzzle(e.id)!;
      const root = puzzleValues(p, p.board, p.player);
      const wins = correctMoves(p.kind, root);
      expect(wins.length, p.id).toBeGreaterThan(0);
      expect(wins.length).toBeLessThan(root.size);
      for (const a of wins) expect(result(apply(p.board, p.player, a).board, -p.player as Player), p.id).toBe(0);
      const visited = new Set<string>();
      const walk = (b: Board, turn: Player, depth: number) => {
        expect(depth).toBeLessThanOrEqual(2 * (25 - p.board.filter(Boolean).length) + 1);
        if (result(b, turn)) { expect(result(b, p.player), p.id).toBe(1); return; }
        const key = `${turn}:${b.join(',')}`;
        if (visited.has(key)) return;
        visited.add(key);
        const actions = turn === p.player ? correctMoves(p.kind, puzzleValues(p, b, turn)) : [bestReply(p, b, turn)];
        expect(actions.length, p.id).toBeGreaterThan(0);
        for (const a of actions) { expect(legal(b, turn)).toContain(a); walk(apply(b, turn, a).board, -turn as Player, depth + 1); }
      };
      walk(p.board, p.player, 0);
    }
  });
  test('모든 오답에도 실제로 막는 응수가 준비돼 있다', () => {
    for (const e of bank) {
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
