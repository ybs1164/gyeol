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
import type { PuzzleMistake, RecordKind, RecordPuzzleData } from './record-types';

export const UNIQUE_PUZZLE_CRITERIA = {
  version: 2,
  minRemaining: 1,
  maxRemaining: 6,
  /** 첫 국면에서 서로 다른 판을 만드는 선택지가 이 이상이어야 고르는 의미가 있다 */
  minChoices: 3,
  maxProofNodes: 300,
} as const;

export type UniqueReject =
  | 'out-of-range' | 'forced-pass' | 'few-choices' | 'no-win' | 'not-unique' | 'line-not-unique'
  | 'immediate-finish' | 'played-move-not-solution' | 'mover-lost' | 'large-proof' | 'solver-limit';

/**
 * 출제 기준: 퍼즐 국면은 상대가 직전에 실수한 바로 다음 판이다(퍼즐 = 그 실수를 응징하기).
 * - exact: 상대가 다른 수로 이기거나 비길 수 있었는데, 실제 수로 강제 패배가 됐다(결과가 뒤집힌 수).
 * - ai: 상대의 AI 탐색 승률이 가장 좋은 다른 수보다 aiMinDrop 이상 떨어졌고, 실수 전에는 aiMinBefore 이상이었다.
 *   앱의 수 평가에서 35점 이상 손실은 블런더(??)다.
 */
export const MISTAKE_CRITERIA = {
  version: 1,
  aiMinDrop: 0.35,
  aiMinBefore: 0.4,
} as const;
const sameBoard = (a: Board, b: Board) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 저장된 직전 실수의 모양과 기준만 확인한다(탐색 없음). 문제가 있으면 이유, 없으면 null. */
export function mistakeProblem(p: RecordPuzzleData, m: PuzzleMistake | undefined = p.mistake): string | null {
  if (!m) return 'missing-mistake';
  const opponent = -p.player as Player;
  if (!Array.isArray(m.board) || m.board.length !== p.board.length || !m.board.every((v) => Number.isInteger(v) && Math.abs(v) <= 4)) return 'mistake-bad-board';
  if (result(m.board, opponent)) return 'mistake-bad-board';
  const actions = legal(m.board, opponent);
  if (m.action === PASS || !actions.includes(m.action)) return 'mistake-illegal';
  if (!sameBoard(apply(m.board, opponent, m.action).board, p.board)) return 'mistake-board-mismatch';
  if (m.best === m.action || !actions.includes(m.best) || sameBoard(apply(m.board, opponent, m.best).board, p.board)) return 'mistake-bad-alternative';
  const puzzleJudge = p.format === 'move' ? p.judge : 'exact';
  if (m.judge !== puzzleJudge) return 'mistake-judge-mismatch';
  if (m.judge === 'exact') {
    if (![1, 0].includes(m.before) || m.after !== -1) return 'mistake-not-decisive';
  } else {
    if (!(m.before >= 0 && m.before <= 1 && m.after >= 0 && m.after <= 1)) return 'mistake-bad-value';
    if (m.before < MISTAKE_CRITERIA.aiMinBefore || m.before - m.after < MISTAKE_CRITERIA.aiMinDrop - 1e-9) return 'mistake-too-small';
  }
  return null;
}

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
  // 직전 실수가 붙은 문제는 그 기록도 확인한다. 실수 기준 이전에 만든 은행(실수 없음)은 그대로 받는다.
  if (p.mistake !== undefined) { const bad = mistakeProblem(p); if (bad) return bad; }
  if (p.format === 'move') return keepPuzzleProblem(p);
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
  if (p.format === 'move' && p.judge !== 'exact') return 'not-exact';
  // 한 수 문제의 저장 값은 승패(1/0/-1)라 부호만 비교한다
  const same = (stored: number, exact: number) => p.format === 'move' ? Math.sign(stored) === Math.sign(exact) : stored === exact;
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
      for (const [a, v] of values) if (!same(v, -exact(apply(b, 1, a).board, -1))) return `wrong-value:${a}`;
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'budget') return 'budget';
    throw error;
  }
  return null;
}

/**
 * 한 수 문제("유리함을 지키는 단 하나의 수"): 둘 차례가 유리한 국면에서, 그 유리함을 지키는 수가 하나뿐이다.
 * - exact: 종국까지 계산해 강제 승리가 있고, 승리를 지키는 수(서로 다른 결과 판)가 정확히 하나. 나머지는 무승부나 패배.
 * - ai: 종국 계산이 닿지 않는 오프닝·중반. 정답 = 둔 뒤에도 불리해지지 않는 수(AI 탐색 승률 notWorse 이상). 이기던 판을
 *   지키는 수도 정답이다. 그런 수(서로 다른 결과 판)가 정확히 하나여야 하고, 탐색 오차로 갈리지 않도록 정답은 notWorse + margin
 *   이상, 나머지는 모두 notWorse − margin 이하여야 한다. 판정은 추정이므로 화면에 AI 판정이라고 표시한다.
 */
export const KEEP_PUZZLE_CRITERIA = {
  version: 3,
  minRemaining: 4,
  /** 첫 수 직후(남은 22장)부터: 오프닝의 실수도 응징 문제로 쓴다 */
  maxRemaining: 22,
  /** 이 이하에서는 먼저 종국 계산을 시도한다 */
  exactMaxRemaining: 9,
  minChoices: 3,
  /** ai 판정: 불리해지지 않음 = 승률 50% 이상 */
  notWorse: 0.5,
  /** ai 판정: 정답과 오답이 경계에서 이만큼 떨어져 있어야 한다 */
  margin: 0.025,
} as const;

/** 수마다 평가(승률 또는 승패)를 받아 한 수 문제를 만든다. 조건이 맞지 않으면 이유. */
export function buildKeepPuzzle(
  board: Board, player: Player,
  opts: { id: string; judge: 'exact' | 'ai'; evals: Map<number, number>; source: PuzzleSource; raw: number; model?: string },
): RecordPuzzleData | 'few-choices' | 'not-unique' | 'no-win' | 'immediate-finish' | 'unclear' {
  const actions = legal(board, player);
  const evals = actions.map((a) => [a, opts.evals.get(a)!] as [number, number]);
  if (evals.some(([, v]) => v === undefined || !Number.isFinite(v))) throw new Error('Missing move evaluation');
  const boardOf = new Map(actions.map((a) => [a, apply(board, player, a).board.join(',')]));
  if (new Set(boardOf.values()).size < KEEP_PUZZLE_CRITERIA.minChoices) return 'few-choices';
  const C = KEEP_PUZZLE_CRITERIA;
  const keeps = (v: number) => opts.judge === 'exact' ? v > 0 : v >= C.notWorse;
  const winners = evals.filter(([, v]) => keeps(v));
  if (!winners.length) return 'no-win';
  if (new Set(winners.map(([a]) => boardOf.get(a))).size !== 1) return 'not-unique';
  if (opts.judge === 'ai') {
    const best = Math.max(...winners.map(([, v]) => v));
    const rival = Math.max(...evals.filter(([a]) => boardOf.get(a) !== boardOf.get(winners[0][0])).map(([, v]) => v));
    if (best < C.notWorse + C.margin - 1e-9 || rival > C.notWorse - C.margin + 1e-9) return 'unclear';
  }
  if (result(apply(board, player, winners[0][0]).board, -player as Player)) return 'immediate-finish';
  const key = positionKey(board, player);
  const values: [number, number][] = evals.map(([a, v]) => [a, keeps(v) ? 1 : opts.judge === 'exact' ? Math.max(-1, Math.min(0, v)) : -1]);
  return {
    id: opts.id, kind: 'keep', board, player, plies: 1, target: 0, raw: opts.raw, rating: 0, source: opts.source,
    proof: [[key, values]], solverNodes: 0, guaranteedMargin: 0, format: 'move', judge: opts.judge, evals,
    ...(opts.model ? { model: opts.model } : {}),
  };
}

/** 한 수 문제의 저장 값 검사(탐색 없음). 문제가 있으면 이유, 없으면 null. */
export function keepPuzzleProblem(p: RecordPuzzleData): string | null {
  if (p.format !== 'move' || p.kind !== 'keep' || (p.judge !== 'exact' && p.judge !== 'ai')) return 'not-keep-puzzle';
  if (p.proof.length !== 1 || !p.evals) return 'bad-shape';
  const [key, values] = p.proof[0];
  if (key !== positionKey(p.board, p.player) || result(p.board, p.player)) return 'bad-root';
  const remaining = TOTAL_TILES - tileCount(p.board);
  if (remaining < KEEP_PUZZLE_CRITERIA.minRemaining || remaining > KEEP_PUZZLE_CRITERIA.maxRemaining) return 'out-of-range';
  const actions = legal(p.board, p.player);
  if (values.length !== actions.length || values.some(([a], i) => a !== actions[i])) return 'proof-actions-mismatch';
  if (p.evals.length !== actions.length || p.evals.some(([a], i) => a !== actions[i])) return 'eval-actions-mismatch';
  const rebuilt = buildKeepPuzzle(p.board, p.player, { id: p.id, judge: p.judge, evals: new Map(p.evals), source: p.source, raw: p.raw });
  if (typeof rebuilt === 'string') return rebuilt;
  if (JSON.stringify(rebuilt.proof) !== JSON.stringify(p.proof)) return 'proof-eval-mismatch';
  return null;
}
