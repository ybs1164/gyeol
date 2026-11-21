/**
 * 정답이 하나뿐인 퍼즐 발췌·검사. 서버의 퍼즐 생성기(db-cli mine-puzzles)와 앱이 같은 기준을 쓴다.
 *
 * "정답이 하나" = 푸는 쪽 차례마다 이기는(종국 타일 차이 > 0) 수가 만드는 판이 정확히 하나다.
 * 상대가 같은 최선 값으로 막는 응수가 여럿이면 그 모든 응수 뒤에서도 똑같이 하나여야 한다.
 * 서로 다른 행동이 같은 판을 만들면 한 가지 경우로 센다(화면에서 구별할 수 없는 같은 수).
 */
import { ExactEndgame, positionKey } from './endgame';
import { PASS, TOTAL_TILES, apply, legal, margin, result, tileCount, type Board, type Player } from './rules';
import { symmetryKey } from './symmetry';
import type { RecordKind, RecordPuzzleData } from './record-types';

export const UNIQUE_PUZZLE_CRITERIA = {
  version: 1,
  minRemaining: 1,
  maxRemaining: 6,
  /** 첫 국면에서 서로 다른 판을 만드는 선택지가 이 이상이어야 고르는 의미가 있다 */
  minChoices: 3,
  maxProofNodes: 300,
} as const;

export type UniqueReject =
  | 'out-of-range' | 'forced-pass' | 'few-choices' | 'no-win' | 'not-unique' | 'line-not-unique'
  | 'immediate-finish' | 'played-move-not-solution' | 'mover-lost' | 'large-proof' | 'solver-limit';

export interface PuzzleSource { gameId: string; type: 'online' | 'ai'; reference: string; ply: number; moveNumber: number; playedMove: number }

/** 이기는 수가 만드는 서로 다른 판의 수 */
export function distinctWinningBoards(board: Board, player: Player, values: Iterable<[number, number]>): number {
  const boards = new Set<string>();
  for (const [a, v] of values) if (v > 0) boards.add(apply(board, player, a).board.join(','));
  return boards.size;
}

/** 8대칭을 하나로 묶은 키. 서버가 이 키의 해시로 퍼즐 ID를 만든다. */
export const puzzleSymmetryKey = (board: Board, player: Player): string => symmetryKey(board, player);

class Reject extends Error { constructor(readonly reason: UniqueReject) { super(reason); } }

/**
 * 실제 대국의 한 국면에서 정답이 하나뿐인 퍼즐을 만든다. 조건이 맞지 않으면 이유를 돌려준다.
 * solver 는 같은 대국 안에서 재사용해도 된다(정확한 값만 캐시한다).
 */
export function extractUniquePuzzle(
  board: Board, player: Player, opts: { id: string; solver: ExactEndgame; source: PuzzleSource; moverWon: boolean; maxRemaining?: number },
): RecordPuzzleData | UniqueReject {
  const { solver, source } = opts;
  const remaining = TOTAL_TILES - tileCount(board);
  if (remaining < UNIQUE_PUZZLE_CRITERIA.minRemaining || remaining > (opts.maxRemaining ?? UNIQUE_PUZZLE_CRITERIA.maxRemaining)) return 'out-of-range';
  if (result(board, player)) return 'out-of-range';
  const actions = legal(board, player);
  if (actions[0] === PASS) return 'forced-pass';
  if (new Set(actions.map((a) => apply(board, player, a).board.join(','))).size < UNIQUE_PUZZLE_CRITERIA.minChoices) return 'few-choices';
  if (!opts.moverWon) return 'mover-lost';
  const startNodes = solver.nodes;
  try {
    const rootValues = solver.values(board, player);
    const wins = rootValues.filter(([, v]) => v > 0);
    if (!wins.length) return 'no-win';
    if (distinctWinningBoards(board, player, rootValues) !== 1) return 'not-unique';
    if (!wins.some(([a]) => a === source.playedMove)) return 'played-move-not-solution';
    if (result(apply(board, player, wins[0][0]).board, -player as Player)) return 'immediate-finish';

    const proof = new Map<string, [number, number][]>();
    const walked = new Set<string>();
    let plies = 0;
    const visit = (state: Board, turn: Player, depth: number) => {
      plies = Math.max(plies, depth);
      if (result(state, turn)) return;
      const key = positionKey(state, turn);
      // 색을 맞바꾼 같은 국면이 푸는 쪽·막는 쪽 차례로 각각 나올 수 있어 역할까지 구분한다
      const walk = `${turn === player}:${key}`;
      if (walked.has(walk)) return;
      walked.add(walk);
      const values = proof.get(key) ?? solver.values(state, turn);
      proof.set(key, values);
      if (proof.size > UNIQUE_PUZZLE_CRITERIA.maxProofNodes) throw new Reject('large-proof');
      if (turn === player) {
        if (distinctWinningBoards(state, turn, values) !== 1) throw new Reject('line-not-unique');
        const win = values.find(([, v]) => v > 0)!;
        for (const [a, v] of values) {
          if (v > 0) continue;
          // 오답을 두면 상대가 실제로 막는 응수를 보여줘야 한다
          const child = apply(state, turn, a).board;
          if (!result(child, -turn as Player)) {
            const childKey = positionKey(child, -turn as Player);
            if (!proof.has(childKey)) proof.set(childKey, solver.values(child, -turn as Player));
          }
        }
        visit(apply(state, turn, win[0]).board, -turn as Player, depth + 1);
      } else {
        const best = Math.max(...values.map(([, v]) => v));
        for (const [a, v] of values) if (v === best) visit(apply(state, turn, a).board, -turn as Player, depth + 1);
      }
    };
    visit(board, player, 0);
    if (proof.size > UNIQUE_PUZZLE_CRITERIA.maxProofNodes) return 'large-proof';

    const guaranteed = wins[0][1];
    const current = margin(board) * player;
    const kind: RecordKind = current < -2 ? 'turnaround' : current < 3 && guaranteed >= 5 ? 'advantage' : 'win';
    const choices = new Set(actions.map((a) => apply(board, player, a).board.join(','))).size;
    const flips = actions.map((a) => ({ a, n: apply(board, player, a).last.flipped?.length ?? 0 }));
    const maxFlips = Math.max(...flips.map((f) => f.n));
    const greedyTrap = flips.filter((f) => f.n === maxFlips).every((f) => !wins.some(([w]) => w === f.a));
    const nodes = solver.nodes - startNodes;
    const raw = 2 * remaining + Math.log2(choices) + 0.3 * Math.log2(1 + nodes) + 0.5 * Math.log2(proof.size) + (current < 0 ? 0.4 : 0) + (greedyTrap ? 1 : 0);
    return {
      id: opts.id, kind, board, player, plies, target: guaranteed, raw, rating: 0, source,
      proof: [...proof], solverNodes: nodes, guaranteedMargin: guaranteed,
    };
  } catch (error) {
    if (error instanceof Reject) return error.reason;
    if (error instanceof Error && error.message === 'Exact endgame node limit exceeded') return 'solver-limit';
    throw error;
  }
}

/**
 * 저장된 풀이 값만으로 정답이 하나뿐인지, 화면이 쓰는 국면이 모두 들어 있는지 확인한다(탐색 없음, 빠름).
 * 서버가 은행을 내보낼 때와 앱이 은행을 받을 때 쓴다. 문제가 있으면 이유를, 없으면 null.
 */
export function uniqueProofProblem(p: RecordPuzzleData): string | null {
  const proof = new Map(p.proof);
  if (proof.size !== p.proof.length) return 'duplicate-proof-node';
  const limit = 2 * (TOTAL_TILES - tileCount(p.board)) + 1;
  const walked = new Set<string>();
  let wins = 0;
  const walk = (b: Board, turn: Player, depth: number): string | null => {
    if (depth > limit) return 'too-long';
    if (result(b, turn)) { if (result(b, p.player) !== 1) return 'line-not-winning'; wins++; return null; }
    const key = positionKey(b, turn);
    const tag = `${turn === p.player}:${key}`;
    if (walked.has(tag)) return null;
    walked.add(tag);
    const values = proof.get(key);
    if (!values) return 'missing-proof-node';
    const actions = legal(b, turn);
    if (values.length !== actions.length || values.some(([a], i) => a !== actions[i])) return 'proof-actions-mismatch';
    if (turn === p.player) {
      if (distinctWinningBoards(b, turn, values) !== 1) return 'not-unique';
      if (depth === 0 && result(apply(b, turn, values.find(([, v]) => v > 0)![0]).board, -turn as Player)) return 'immediate-finish';
      for (const [a, v] of values) {
        if (v > 0) continue;
        const child = apply(b, turn, a).board;
        if (!result(child, -turn as Player) && !proof.has(positionKey(child, -turn as Player))) return 'missing-wrong-move-reply';
      }
      return walk(apply(b, turn, values.find(([, v]) => v > 0)![0]).board, -turn as Player, depth + 1);
    }
    const best = Math.max(...values.map(([, v]) => v));
    for (const [a, v] of values) if (v === best) { const bad = walk(apply(b, turn, a).board, -turn as Player, depth + 1); if (bad) return bad; }
    return null;
  };
  const bad = walk(p.board, p.player, 0);
  return bad ?? (wins ? null : 'no-terminal-line');
}

/**
 * 생성기와 다른 방법(알파베타·캐시 없이 모든 합법 수를 끝까지 열거)으로 저장된 값을 모두 다시 계산한다.
 * 계산 한도를 넘으면 'budget', 값이 다르면 이유, 통과하면 null.
 */
export function bruteForceProblem(p: RecordPuzzleData, budget = 3_000_000): string | null {
  let nodes = 0;
  const memo = new Map<string, number>();
  const exact = (board: Board, player: Player): number => {
    const key = `${player}:${board.join(',')}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (++nodes > budget) throw new Error('budget');
    const value = result(board, player) ? margin(board) * player
      : Math.max(...legal(board, player).map((a) => -exact(apply(board, player, a).board, -player as Player)));
    memo.set(key, value);
    return value;
  };
  try {
    for (const [key, values] of p.proof) {
      const b = [...key].map((v) => Number(v) - 5);
      for (const [a, v] of values) if (-exact(apply(b, 1, a).board, -1) !== v) return `wrong-value:${a}`;
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'budget') return 'budget';
    throw error;
  }
  return null;
}
