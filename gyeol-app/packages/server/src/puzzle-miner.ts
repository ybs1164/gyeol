/**
 * 서버 퍼즐 생성기: 실제 대국 기보에서 "상대가 방금 실수했고, 그 실수를 응징하는 정답이 하나뿐인" 국면을 발췌해 은행 파일을 만든다.
 *
 * 출제 기준(MISTAKE_CRITERIA): 모든 문제는 상대의 직전 수가 실수인 국면에서 시작한다. 은행에 그 실수(직전 판·수·평가)를 남겨
 * 앱이 상대의 실수를 보여 준 뒤 문제를 낸다.
 *   - 종국 계산 범위(남은 9장 이하): 상대가 다른 수로 이기거나 비길 수 있었는데 실제 수로 강제 패배가 된 경우만.
 *   - 그보다 이른 오프닝·중반(AI 판정): 상대의 AI 탐색 승률이 가장 좋은 다른 수보다 35%p 이상 떨어진 경우만.
 *
 * 원본
 *   - archive: 패키지에 함께 넣은 검증된 AI 대국 기보(tools/record-puzzles/source-games.json)
 *   - db: 이 서버에서 정상 종국한 온라인 대국(사람·AI 플레이어). 읽기 전용으로 연다.
 *
 * 두 갈래(packages/core/src/unique-puzzle.ts)
 * 1. 수순 문제(line): 남은 타일 1~6장. 상대 최선 응수와 종국까지 두며, 푸는 쪽 차례마다 이기는 수가 하나뿐이다.
 *    실제로 이긴 쪽이 실제로 둔 수가 정답이어야 하고, 전수 탐색으로 모든 값을 다시 검사한다.
 * 2. 한 수 문제(keep, "유리함을 지키는 단 하나의 수"): 남은 타일 4~20장의 다양한 국면.
 *    - exact: 남은 9장 이하에서 종국까지 계산해 승리를 지키는 수가 하나뿐인 국면. 별도 탐색으로 다시 확인한다.
 *    - ai: 그보다 이른 오프닝·중반. 신경망으로 거른 뒤 모든 수를 MCTS로 평가하고, 앞선 두 수와 50% 경계 근처 수는 더 깊게
 *      다시 탐색해, 둔 뒤 불리해지지 않는(승률 50% 이상) 수가 하나뿐인 국면. 추정 판정이라 은행에 judge: 'ai' 와 모델을 남긴다.
 *
 * 상태(state 폴더): mined.json 에 처리한 대국과 후보를 남겨, 다음 실행은 새 대국(또는 새 모델)만 본다.
 * 출력에는 닉네임·계정 ID·토큰이 없다. 온라인 대국 ID는 해시로만 남긴다.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExactEndgame, KEEP_PUZZLE_CRITERIA, MISTAKE_CRITERIA, PASS, PUZZLE_BANK_SCHEMA, PUZZLE_SCALE, TOTAL_TILES, UNIQUE_PUZZLE_CRITERIA, apply, bruteForceProblem,
  buildKeepPuzzle, canonical, extractUniquePuzzle, initial, isLegal, legal, puzzleSymmetryKey, result, tileCount, uniqueProofProblem, winner,
  type Board, type Player, type PuzzleBankFile, type PuzzleMistake, type RecordPuzzleData,
} from '@gyeol/core';
import { search, type Predict } from '@gyeol/ai';

export const PUZZLE_MINER_VERSION = 3;
const RULE = 'facing-25-v1';

export interface SourceGame {
  id: string;
  type: 'online' | 'ai';
  reference: string;
  initial: Board;
  initialPlayer: Player;
  moves: number[];
  /** 1 선공 승, -1 후공 승, 0 무 */
  winner: number;
  /** 기보 앞에 붙는 고정 초반 수(실험 대국). 수 번호 표시에만 쓴다 */
  prefix: number;
}
/**
 * 한 수 문제에 쓰는 AI. 기본은 난이도 추정(정답에 준 신경망 정책 확률)에만 쓰고, 판정은 종국 계산만 한다.
 * judge: true 면 종국 계산이 닿지 않는 중반을 MCTS로 판정한다(실험용). 2026-11-21 측정에서 기존 690판의
 * 남은 10~20장 국면 495개 중 "한 수만 유리함을 지키는" 국면이 0개여서 서버에서는 끈다.
 */
export interface KeepAi {
  predict: Predict;
  judge?: boolean;
  /** 판정에 쓴 모델 ID(은행에 남긴다) */
  model: string;
  /** 모든 수를 평가하는 MCTS 횟수 */
  sims?: number;
  /** 앞선 두 수를 다시 평가하는 MCTS 횟수 */
  confirmSims?: number;
}
/** AI 한 수 문제: 신경망 거르기의 여유, 그리고 깊게 다시 볼 50% 경계 근처 폭(승률) */
const SCREEN_SLACK = 0.15;
const BOUNDARY_BAND = 0.2;
/** 직전 실수 판정이 실패한 이유 */
type MistakeReject = 'no-previous-move' | 'previous-pass' | 'opponent-already-lost' | 'mistake-limit' | 'mistake-screen' | 'mistake-too-small';
export interface PuzzleMineOptions {
  /** 운영 SQLite(읽기 전용) */
  db?: string;
  /** 보관 기보 JSON(schema 2) */
  archive?: string;
  /** 상태·은행 폴더 */
  state: string;
  /** 은행 파일(기본 state/bank.json) */
  out?: string;
  budgetMinutes?: number;
  nodeLimit?: number;
  verifyBudget?: number;
  maxRemaining?: number;
  /** 한 수 문제를 만들지 않으려면 false */
  keep?: boolean;
  ai?: KeepAi;
  now?: () => number;
  log?: (line: string) => void;
}
type Rejected = Record<string, number>;
interface GameEntry {
  puzzles: RecordPuzzleData[];
  rejected: Rejected;
  /** 한 수 문제: 어떤 판정 단계로 처리했는지(exact 또는 ai:<모델>) */
  keep?: { tier: string; puzzles: RecordPuzzleData[]; rejected: Rejected };
}
interface State {
  version: number;
  criteriaVersion: string;
  maxRemaining: number;
  games: Record<string, GameEntry>;
}
export interface PuzzleMineReport {
  out: string;
  /** 이번 실행에서 은행 파일을 새로 썼는가 */
  written: boolean;
  version: string;
  puzzles: number;
  formats: Record<string, number>;
  processedGames: number;
  newGames: number;
  pendingGames: number;
  sources: Record<string, number>;
  rejected: Record<string, number>;
  stages: { n: number; lo: number; hi: number; count: number }[];
  seconds: number;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const puzzleId = (board: Board, player: Player) => 'rp-' + digest(puzzleSymmetryKey(board, player)).slice(0, 16);

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

export function readArchive(path: string): SourceGame[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    schema: number;
    games: { id: string; source: string; sourceIndex: string | number; initial: Board; initialPlayer: Player; moves: number[]; winner: number; openingProof?: { prefix: number[] } }[];
  };
  if (data.schema !== 2) throw new Error('Unknown archive schema');
  return data.games.map((g) => ({
    id: g.id, type: g.source === 'online-record' ? 'online' : 'ai', reference: `${g.source}/${g.sourceIndex}`,
    initial: g.initial, initialPlayer: g.initialPlayer, moves: g.moves, winner: g.winner, prefix: g.openingProof?.prefix.length ?? 0,
  }));
}

/** 정상 종국한 대국만. 기권·시간패는 판 위의 승패와 다를 수 있어 쓰지 않는다. */
export function readServerGames(path: string): SourceGame[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const games = db.prepare(`SELECT id, initial_board_json, initial_player, winner FROM games
      WHERE status='finished' AND end_reason='normal' AND rule_version=? ORDER BY finished_at, id`).all(RULE) as Record<string, any>[];
    const movesOf = db.prepare('SELECT action FROM game_moves WHERE game_id=? ORDER BY ply').pluck();
    return games.map((g) => {
      const hashed = 'game-' + digest(`online:${g.id}`).slice(0, 16);
      return { id: hashed, type: 'online' as const, reference: `online/${hashed}`, initial: JSON.parse(g.initial_board_json) as Board,
        initialPlayer: g.initial_player as Player, moves: movesOf.all(g.id) as number[], winner: g.winner as number, prefix: 0 };
    });
  } finally { db.close(); }
}

interface Position { board: Board; player: Player; ply: number }
/** 기보를 다시 두며 국면을 모은다. 규칙에 어긋나거나 결과가 다르면 null. */
function replayGame(game: SourceGame): Position[] | null {
  let board = game.initial.slice(), player = game.initialPlayer;
  if (board.length !== initial().length) return null;
  const positions: Position[] = [];
  for (let ply = 0; ply < game.moves.length; ply++) {
    if (result(board, player) || !isLegal(board, player, game.moves[ply])) return null;
    positions.push({ board, player, ply });
    board = apply(board, player, game.moves[ply]).board;
    player = -player as Player;
  }
  return winner(board, 1) === Math.sign(game.winner) ? positions : null;
}
const sourceOf = (game: SourceGame, pos: Position) => ({
  gameId: game.id, type: game.type, reference: game.reference, ply: pos.ply, moveNumber: game.prefix + pos.ply + 1, playedMove: game.moves[pos.ply],
});

/** 수순 문제: 한 대국에서 정답이 하나뿐인 종반 국면을 모두 찾고 전수 탐색으로 다시 검사한다. */
export function mineGame(game: SourceGame, opts: { nodeLimit: number; verifyBudget: number; maxRemaining: number }): GameEntry {
  const out: GameEntry = { puzzles: [], rejected: {} };
  const reject = (r: string) => { out.rejected[r] = (out.rejected[r] ?? 0) + 1; };
  const positions = replayGame(game);
  if (!positions) { reject('invalid-game'); return out; }
  const solver = new ExactEndgame(opts.nodeLimit);
  const seen = new Set<string>();
  // 종국에 가까운 국면부터 풀어 앞 국면의 탐색이 정확 값 캐시를 재사용하게 한다
  for (const pos of [...positions].reverse()) {
    const id = puzzleId(pos.board, pos.player);
    if (seen.has(id)) continue;
    seen.add(id);
    const found = extractUniquePuzzle(pos.board, pos.player, {
      id, solver, maxRemaining: opts.maxRemaining, moverWon: Math.sign(game.winner) === pos.player, source: sourceOf(game, pos),
    });
    if (typeof found === 'string') { if (found !== 'out-of-range') reject(found); continue; }
    const shape = uniqueProofProblem(found);
    if (shape) throw new Error(`Generator produced an invalid proof (${shape}) for ${found.id}`);
    const brute = bruteForceProblem(found, opts.verifyBudget);
    if (brute === 'budget') { reject('verify-budget'); continue; }
    if (brute) throw new Error(`Independent search disagrees (${brute}) for ${found.id}`);
    const mistake = exactMistake(game, positions, pos.ply, opts.nodeLimit);
    if (typeof mistake === 'string') { reject(mistake); continue; }
    const puzzle = { ...found, mistake };
    const bad = uniqueProofProblem(puzzle);
    if (bad) throw new Error(`Generator produced an invalid mistake (${bad}) for ${found.id}`);
    out.puzzles.push(puzzle);
  }
  return out;
}

/** 상대가 직전에 둔 수와 그 앞 판. 첫 수거나 패스였으면 실수가 아니다. */
function previousMove(game: SourceGame, positions: Position[], ply: number): { prev: Position; action: number } | MistakeReject {
  if (ply < 1) return 'no-previous-move';
  const action = game.moves[ply - 1];
  return action === PASS ? 'previous-pass' : { prev: positions[ply - 1], action };
}

/**
 * 종국 계산으로 확인한 직전 실수. 퍼즐 국면에서 푸는 쪽이 강제 승리를 가진다는 것은 퍼즐 검사가 이미 보였으므로,
 * 상대가 다른 수로 이기거나 비길 수 있었는지만 찾는다. 찾은 다른 수는 다른 탐색 창(타일 차이 전체)으로 다시 계산한다.
 */
function exactMistake(game: SourceGame, positions: Position[], ply: number, nodeLimit: number): PuzzleMistake | MistakeReject {
  const found = previousMove(game, positions, ply);
  if (typeof found === 'string') return found;
  const { prev, action } = found;
  const opponent = prev.player, solverSide = -opponent as Player;
  const played = apply(prev.board, opponent, action).board.join(',');
  const solver = new ExactEndgame(nodeLimit);
  // 상대 기준 결과: 1 승, 0 무, -1 패
  const outcome = (child: Board, s: ExactEndgame, alpha: number, beta: number) =>
    result(child, solverSide) ? terminalOutcome(child, opponent) : -Math.sign(s.value(child, solverSide, alpha, beta));
  try {
    let best: { a: number; v: number } | null = null;
    for (const g of childrenOf(prev.board, opponent)) {
      if (g.board.join(',') === played) continue;
      const v = outcome(g.board, solver, -1, 1);
      if (!best || v > best.v) best = { a: g.actions[0], v };
      if (v === 1) break;
    }
    if (!best || best.v < 0) return 'opponent-already-lost';
    const again = new ExactEndgame(nodeLimit * 4);
    if (outcome(apply(prev.board, opponent, best.a).board, again, -26, 26) !== best.v) {
      throw new Error(`Independent search disagrees on the mistake before ${game.id}/${ply}`);
    }
    return { board: prev.board, action, judge: 'exact', before: best.v, after: -1, best: best.a };
  } catch (error) {
    if (error instanceof Error && error.message === 'Exact endgame node limit exceeded') return 'mistake-limit';
    throw error;
  }
}

/**
 * AI 탐색으로 판정한 직전 실수. screenOnly 면 신경망 두 번으로 대략만 본다. 아니면 상대의 모든 수를 MCTS로 평가하고,
 * 실제 수와 앞선 다른 수 둘은 더 깊게 다시 평가한다.
 */
async function aiMistake(positions: Position[], ply: number, action: number, ai: KeepAi, screenOnly: boolean): Promise<PuzzleMistake | MistakeReject | 'screen-passed'> {
  const prev = positions[ply - 1], here = positions[ply], opponent = prev.player;
  const C = MISTAKE_CRITERIA;
  if (screenOnly) {
    // 실수 전 상대 차례 값과 실수 뒤 내 차례 값(각각 신경망 한 번)의 차이가 실수 크기의 대략이다
    const before = ((await ai.predict(canonical(prev.board, opponent))).value + 1) / 2;
    const after = (1 - (await ai.predict(canonical(here.board, here.player))).value) / 2;
    return before >= C.aiMinBefore - 0.1 && before - after >= C.aiMinDrop * 0.6 ? 'screen-passed' : 'mistake-screen';
  }
  const kids = childrenOf(prev.board, opponent);
  const playedIndex = kids.findIndex((g) => g.board.join(',') === here.board.join(','));
  const sims = ai.sims ?? 128, confirm = ai.confirmSims ?? 512;
  const rates: number[] = [];
  for (const g of kids) rates.push(await childWinRate(g.board, opponent, ai, sims));
  const rivals = kids.map((_, i) => i).filter((i) => i !== playedIndex).sort((a, b) => rates[b] - rates[a]).slice(0, 2);
  if (!rivals.length) return 'opponent-already-lost';
  for (const i of [playedIndex, ...rivals]) rates[i] = await childWinRate(kids[i].board, opponent, ai, confirm);
  const bestIndex = rivals.sort((a, b) => rates[b] - rates[a])[0];
  const before = rates[bestIndex], after = rates[playedIndex];
  if (before < C.aiMinBefore) return 'opponent-already-lost';
  if (before - after < C.aiMinDrop) return 'mistake-too-small';
  return { board: prev.board, action, judge: 'ai', before, after, best: kids[bestIndex].actions[0] };
}

/** 서로 다른 결과 판마다 대표 수 하나. 같은 판을 만드는 수는 같은 평가를 받는다. */
function childrenOf(board: Board, player: Player) {
  const groups = new Map<string, { board: Board; actions: number[] }>();
  for (const a of legal(board, player)) {
    const child = apply(board, player, a).board, key = child.join(',');
    const g = groups.get(key);
    if (g) g.actions.push(a); else groups.set(key, { board: child, actions: [a] });
  }
  return [...groups.values()];
}
const terminalOutcome = (child: Board, player: Player) => { const r = result(child, player); return r > 0.5 ? 1 : r < -0.5 ? -1 : 0; };

/** 종국까지 계산한 수별 승패(둔 사람 기준 1/0/-1). 계산 한도를 넘으면 null. */
function exactOutcomes(board: Board, player: Player, nodes: number): Map<number, number> | null {
  const solver = new ExactEndgame(nodes);
  const evals = new Map<number, number>();
  try {
    for (const g of childrenOf(board, player)) {
      const v = result(g.board, -player as Player) ? terminalOutcome(g.board, player) : -Math.sign(solver.value(g.board, -player as Player, -1, 1));
      for (const a of g.actions) evals.set(a, v);
    }
    return evals;
  } catch (error) {
    if (error instanceof Error && error.message === 'Exact endgame node limit exceeded') return null;
    throw error;
  }
}

/** 둔 사람 기준 승률(0..1). 끝난 판은 1/0.5/0. */
async function childWinRate(child: Board, player: Player, ai: KeepAi, sims: number): Promise<number> {
  if (result(child, -player as Player)) return (terminalOutcome(child, player) + 1) / 2;
  // 평균값(meanValue)은 탐색용 방문까지 섞여 50%로 끌려간다. 상대의 가장 많이 본 응수 값(value)이 이 수의 평가다
  const r = await search(canonical(child, -player as Player), sims, ai.predict, { details: 'none', random: () => 0 });
  return (1 - r.value) / 2;
}

/** 신경망이 정답에 준 확률이 낮을수록(그럴듯한 오답이 많을수록) 어렵다. */
async function keepDifficulty(board: Board, player: Player, correct: Set<number>, ai: KeepAi | undefined): Promise<number> {
  const choices = childrenOf(board, player).length;
  let miss = 0.5;
  if (ai) {
    const { priors } = await ai.predict(canonical(board, player));
    const actions = legal(canonical(board, player), 1);
    if (actions.length === priors.length) {
      let sum = 0, hit = 0;
      actions.forEach((a, i) => { sum += priors[i]; if (correct.has(a)) hit += priors[i]; });
      if (sum > 0) miss = 1 - hit / sum;
    }
  }
  return 8 + 14 * miss + Math.log2(choices) + 0.15 * (TOTAL_TILES - tileCount(board));
}

/** 한 수 문제: 다양한 국면에서 유리함을 지키는 수가 하나뿐인 곳을 찾는다. */
export async function mineKeep(game: SourceGame, opts: { exactNodes: number; verifyBudget: number; ai?: KeepAi }): Promise<NonNullable<GameEntry['keep']>> {
  const out: NonNullable<GameEntry['keep']> = { tier: opts.ai?.judge ? `ai:${opts.ai.model}` : 'exact', puzzles: [], rejected: {} };
  const reject = (r: string) => { out.rejected[r] = (out.rejected[r] ?? 0) + 1; };
  const positions = replayGame(game);
  if (!positions) { reject('invalid-game'); return out; }
  const seen = new Set<string>();
  const C = KEEP_PUZZLE_CRITERIA;
  for (const pos of positions) {
    const { board, player } = pos;
    const remaining = TOTAL_TILES - tileCount(board);
    if (remaining < C.minRemaining || remaining > C.maxRemaining || legal(board, player)[0] === PASS) continue;
    const kids = childrenOf(board, player);
    if (kids.length < C.minChoices) continue;
    const id = puzzleId(board, player);
    if (seen.has(id)) continue;
    seen.add(id);
    const exactRange = remaining <= C.exactMaxRemaining;
    if (!exactRange && !opts.ai?.judge) continue;
    // 상대가 직전에 실수하지 않은 국면은 깊게 보지 않는다(값싼 검사부터)
    const previous = previousMove(game, positions, pos.ply);
    if (typeof previous === 'string') { reject(previous); continue; }
    if (!exactRange) {
      const screen = await aiMistake(positions, pos.ply, previous.action, opts.ai!, true);
      if (screen !== 'screen-passed') { reject(screen as string); continue; }
    }

    let judge: 'exact' | 'ai' | null = null;
    let evals: Map<number, number> | null = null;
    if (exactRange) {
      evals = exactOutcomes(board, player, opts.exactNodes);
      if (evals) judge = 'exact'; else reject('exact-limit');
    }
    if (!evals && opts.ai?.judge) {
      // 1) 신경망 한 번씩으로 거른다: 불리해지지 않는 수가 하나뿐일 수 있는 국면만 깊게 본다(신경망 오차를 감안해 느슨하게)
      // 예측기는 동시에 부르지 않는다(입력 버퍼를 공유한다)
      const quick: number[] = [];
      for (const g of kids) quick.push(result(g.board, -player as Player)
        ? (terminalOutcome(g.board, player) + 1) / 2 : (1 - (await opts.ai.predict(canonical(g.board, -player as Player))).value) / 2);
      const sorted = [...quick].sort((a, b) => b - a);
      if (sorted[0] < C.notWorse - SCREEN_SLACK || sorted[1] > C.notWorse + SCREEN_SLACK) { reject('screen'); continue; }
      // 2) 모든 수를 MCTS로 평가하고 3) 앞선 두 수와 50% 경계 가까운 수는 더 깊게 다시 평가한다
      const sims = opts.ai.sims ?? 128, confirm = opts.ai.confirmSims ?? 512;
      const deep: number[] = [];
      for (const g of kids) deep.push(await childWinRate(g.board, player, opts.ai, sims));
      const order = deep.map((_, i) => i).sort((a, b) => deep[b] - deep[a]);
      // 깊게 보기 전에 이미 분명히 둘 이상이 불리하지 않으면 그만둔다
      if (deep[order[1]] >= C.notWorse + BOUNDARY_BAND) { reject('keep-not-unique'); continue; }
      for (const [rank, i] of order.entries()) {
        if (rank < 2 || Math.abs(deep[i] - C.notWorse) <= BOUNDARY_BAND) deep[i] = await childWinRate(kids[i].board, player, opts.ai, confirm);
      }
      evals = new Map();
      kids.forEach((g, i) => { for (const a of g.actions) evals!.set(a, deep[i]); });
      judge = 'ai';
    }
    if (!evals || !judge) continue;
    const correct = new Set([...evals].filter(([, v]) => judge === 'exact' ? v > 0 : v >= C.notWorse).map(([a]) => a));
    const built = buildKeepPuzzle(board, player, {
      id, judge, evals, source: sourceOf(game, pos), raw: await keepDifficulty(board, player, correct, opts.ai),
      ...(judge === 'ai' ? { model: opts.ai!.model } : {}),
    });
    if (typeof built === 'string') { reject(`keep-${built}`); continue; }
    if (judge === 'exact') {
      // 다른 탐색으로 다시 확인: 작은 국면은 가지치기 없는 전수 탐색, 큰 국면은 타일 차이 전체 창의 새 탐색
      const brute = remaining <= 6 ? bruteForceProblem(built, opts.verifyBudget) : 'budget';
      if (brute && brute !== 'budget') throw new Error(`Independent search disagrees (${brute}) for ${built.id}`);
      if (brute === 'budget') {
        const again = new ExactEndgame(opts.exactNodes * 4);
        try {
          for (const [a, v] of built.proof[0][1]) {
            const child = apply(board, player, a).board;
            const w = result(child, -player as Player) ? terminalOutcome(child, player) : -Math.sign(again.value(child, -player as Player));
            if (Math.sign(v) !== w) throw new Error(`Independent search disagrees for ${built.id}/${a}`);
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'Exact endgame node limit exceeded') { reject('verify-budget'); continue; }
          throw error;
        }
      }
    }
    const mistake = judge === 'exact'
      ? exactMistake(game, positions, pos.ply, opts.exactNodes)
      : await aiMistake(positions, pos.ply, previous.action, opts.ai!, false);
    if (typeof mistake === 'string') { reject(mistake); continue; }
    const puzzle: RecordPuzzleData = { ...built, mistake: mistake as PuzzleMistake };
    const shape = uniqueProofProblem(puzzle);
    if (shape) throw new Error(`Generator produced an invalid keep puzzle (${shape}) for ${built.id}`);
    out.puzzles.push(puzzle);
  }
  return out;
}

/** 쉬운 문제부터 8단계 점수 구간에 고르게 나눈다(기존 실전 퍼즐 은행과 같은 방식). */
export function assignRatings(puzzles: RecordPuzzleData[]): RecordPuzzleData[] {
  const sorted = [...puzzles].sort((a, b) => a.raw - b.raw || a.id.localeCompare(b.id));
  const floors = PUZZLE_SCALE.stageFloors;
  return sorted.map((p, i) => {
    const pos = ((i + 0.5) / sorted.length) * floors.length;
    const stage = Math.min(floors.length - 1, Math.floor(pos));
    const lo = floors[stage], hi = floors[stage + 1] ?? PUZZLE_SCALE.puzzleMax;
    return { ...p, rating: Math.min(hi - 1, Math.round(lo + (pos - stage) * (hi - lo))) };
  });
}

export async function minePuzzles(options: PuzzleMineOptions): Promise<PuzzleMineReport> {
  const now = options.now ?? Date.now, started = now();
  const log = options.log ?? (() => undefined);
  const maxRemaining = options.maxRemaining ?? UNIQUE_PUZZLE_CRITERIA.maxRemaining;
  const nodeLimit = options.nodeLimit ?? 2_000_000, verifyBudget = options.verifyBudget ?? 3_000_000;
  const keepOn = options.keep !== false;
  const keepTier = options.ai?.judge ? `ai:${options.ai.model}` : 'exact';
  const deadline = started + (options.budgetMinutes ?? 50) * 60_000;
  const criteriaVersion = `${UNIQUE_PUZZLE_CRITERIA.version}.${KEEP_PUZZLE_CRITERIA.version}.${MISTAKE_CRITERIA.version}`;
  mkdirSync(options.state, { recursive: true, mode: 0o700 });
  const stateFile = join(options.state, 'mined.json');
  const out = options.out ?? join(options.state, 'bank.json');
  let state: State = { version: PUZZLE_MINER_VERSION, criteriaVersion, maxRemaining, games: {} };
  if (existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
    // 기준이 바뀌면 처음부터 다시 발췌한다
    if (saved.version === PUZZLE_MINER_VERSION && saved.criteriaVersion === criteriaVersion && saved.maxRemaining === maxRemaining) state = saved;
  }
  const archive = options.archive ? readArchive(options.archive) : [];
  const server = options.db ? readServerGames(options.db) : [];
  const all = [...archive, ...server];
  const needsKeep = (e: GameEntry | undefined) => keepOn && e?.keep?.tier !== keepTier;
  const pending = all.filter((g) => !state.games[g.id] || needsKeep(state.games[g.id]));
  let newGames = 0;
  for (const game of pending) {
    if (now() > deadline) break;
    const entry = state.games[game.id] ?? mineGame(game, { nodeLimit, verifyBudget, maxRemaining });
    if (keepOn && needsKeep(entry)) entry.keep = await mineKeep(game, { exactNodes: 1_500_000, verifyBudget, ai: options.ai });
    state.games[game.id] = entry;
    newGames++;
    if (newGames % 10 === 0) {
      writeAtomic(stateFile, JSON.stringify(state));
      log(`${newGames}/${pending.length} games`);
    }
  }
  writeAtomic(stateFile, JSON.stringify(state));

  // 대칭 중복은 하나만. 같은 국면이면 수순 문제를 우선하고, 여러 대국에서 나오면 대국 ID 순서로 먼저인 출처를 쓴다
  const known = new Set(all.map((g) => g.id));
  const unique = new Map<string, RecordPuzzleData>();
  const rejected: Record<string, number> = {};
  const entries = Object.entries(state.games).filter(([id]) => known.has(id)).sort(([a], [b]) => a.localeCompare(b));
  for (const [, entry] of entries) {
    for (const [r, n] of Object.entries(entry.rejected)) rejected[r] = (rejected[r] ?? 0) + n;
    for (const p of entry.puzzles) if (!unique.has(p.id)) unique.set(p.id, p);
  }
  for (const [, entry] of entries) {
    if (!keepOn || !entry.keep) continue;
    for (const [r, n] of Object.entries(entry.keep.rejected)) rejected[r] = (rejected[r] ?? 0) + n;
    for (const p of entry.keep.puzzles) if (!unique.has(p.id)) unique.set(p.id, p);
  }
  const puzzles = assignRatings([...unique.values()]);
  const version = digest(JSON.stringify(puzzles)).slice(0, 16);
  const sources = {
    archiveGames: archive.filter((g) => state.games[g.id]).length,
    serverGames: server.filter((g) => state.games[g.id]).length,
  };
  const formats: Record<string, number> = {};
  for (const p of puzzles) { const k = p.format === 'move' ? `move-${p.judge}` : 'line'; formats[k] = (formats[k] ?? 0) + 1; }
  const bank: PuzzleBankFile = {
    schema: PUZZLE_BANK_SCHEMA, rule: RULE, version, generatedAt: new Date(now()).toISOString(),
    criteria: {
      line: { ...UNIQUE_PUZZLE_CRITERIA, maxRemaining, solution: 'exactly one winning resulting board at every solver turn against every equally strong defense', verifiedBy: 'exhaustive minimax without pruning' },
      keep: { ...KEEP_PUZZLE_CRITERIA, tier: keepOn ? keepTier : 'off', solution: 'exactly one move keeps the advantage (forced win when exact; AI win rate otherwise)' },
      mistake: { ...MISTAKE_CRITERIA, rule: 'starts right after the opponent mistake: a win or draw thrown into a forced loss (exact), or an AI win-rate drop of at least aiMinDrop (ai)' },
    },
    sources, puzzles,
  };
  // 기준이 바뀌어 처음부터 다시 발췌하는 동안에는 이전 은행을 그대로 두고, 모든 대국을 본 뒤에 바꾼다
  const written = puzzles.length > 0 && (pending.length === newGames || !existsSync(out));
  if (written) writeAtomic(out, JSON.stringify(bank));
  const floors = PUZZLE_SCALE.stageFloors;
  return {
    out, written, version, puzzles: puzzles.length, formats, processedGames: entries.length,
    newGames, pendingGames: pending.length - newGames, sources, rejected,
    stages: floors.map((lo, i) => {
      const hi = floors[i + 1] ?? PUZZLE_SCALE.puzzleMax;
      return { n: i + 1, lo, hi, count: puzzles.filter((p) => p.rating >= lo && p.rating < hi).length };
    }),
    seconds: Math.round((now() - started) / 1000),
  };
}
