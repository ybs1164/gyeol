/**
 * 서버 퍼즐 생성기: 실제 대국 기보에서 "정답이 하나뿐인" 후반 국면만 발췌해 은행 파일을 만든다.
 *
 * 원본
 *   - archive: 패키지에 함께 넣은 검증된 AI 대국 기보(tools/record-puzzles/source-games.json)
 *   - db: 이 서버에서 정상 종국한 온라인 대국(사람·AI 플레이어). 읽기 전용으로 연다.
 * 기준(packages/core/src/unique-puzzle.ts)
 *   - 실제로 이긴 쪽이 실제로 둔 수가 유일한 정답이어야 한다.
 *   - 푸는 쪽 차례마다 이기는 수가 만드는 판이 하나뿐이다(상대의 같은 값 최선 응수 전부에 대해).
 *   - 한 수로 바로 끝나는 문제, 선택지가 3개 미만인 국면은 제외한다.
 *   - 생성기(알파베타 정확 탐색)와 별도로, 모든 수를 끝까지 열거하는 전수 탐색으로 저장 값을 다시 검사한다.
 *
 * 상태(state 폴더): mined.json 에 처리한 대국과 그 대국에서 나온 후보를 남겨, 다음 실행은 새 대국만 본다.
 * 출력에는 닉네임·계정 ID·토큰이 없다. 온라인 대국 ID는 해시로만 남긴다.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExactEndgame, PUZZLE_BANK_SCHEMA, PUZZLE_SCALE, UNIQUE_PUZZLE_CRITERIA, apply, bruteForceProblem, extractUniquePuzzle, initial, isLegal,
  puzzleSymmetryKey, result, uniqueProofProblem, winner, type Board, type Player, type PuzzleBankFile, type RecordPuzzleData, type UniqueReject,
} from '@gyeol/core';

export const PUZZLE_MINER_VERSION = 1;
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
  now?: () => number;
  log?: (line: string) => void;
}
interface State {
  version: number;
  criteriaVersion: number;
  maxRemaining: number;
  games: Record<string, { puzzles: RecordPuzzleData[]; rejected: Partial<Record<UniqueReject | 'verify-budget' | 'verify-mismatch' | 'invalid-game', number>> }>;
}
export interface PuzzleMineReport {
  out: string;
  version: string;
  puzzles: number;
  processedGames: number;
  newGames: number;
  pendingGames: number;
  sources: Record<string, number>;
  rejected: Record<string, number>;
  stages: { n: number; lo: number; hi: number; count: number }[];
  seconds: number;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

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

/** 한 대국에서 정답이 하나뿐인 국면을 모두 찾고 전수 탐색으로 다시 검사한다. */
export function mineGame(game: SourceGame, opts: { nodeLimit: number; verifyBudget: number; maxRemaining: number }): State['games'][string] {
  const out: State['games'][string] = { puzzles: [], rejected: {} };
  const reject = (r: keyof State['games'][string]['rejected']) => { out.rejected[r] = (out.rejected[r] ?? 0) + 1; };
  let board = game.initial.slice(), player = game.initialPlayer;
  if (board.length !== initial().length) { reject('invalid-game'); return out; }
  const positions: { board: Board; player: Player; ply: number }[] = [];
  for (let ply = 0; ply < game.moves.length; ply++) {
    if (result(board, player) || !isLegal(board, player, game.moves[ply])) { reject('invalid-game'); return out; }
    positions.push({ board, player, ply });
    board = apply(board, player, game.moves[ply]).board;
    player = -player as Player;
  }
  if (winner(board, 1) !== Math.sign(game.winner)) { reject('invalid-game'); return out; }
  const solver = new ExactEndgame(opts.nodeLimit);
  const seen = new Set<string>();
  // 종국에 가까운 국면부터 풀어 앞 국면의 탐색이 정확 값 캐시를 재사용하게 한다
  for (const pos of positions.reverse()) {
    const sym = puzzleSymmetryKey(pos.board, pos.player);
    if (seen.has(sym)) continue;
    seen.add(sym);
    const found = extractUniquePuzzle(pos.board, pos.player, {
      id: 'rp-' + digest(sym).slice(0, 16), solver, maxRemaining: opts.maxRemaining, moverWon: Math.sign(game.winner) === pos.player,
      source: { gameId: game.id, type: game.type, reference: game.reference, ply: pos.ply, moveNumber: game.prefix + pos.ply + 1, playedMove: game.moves[pos.ply] },
    });
    if (typeof found === 'string') { if (found !== 'out-of-range') reject(found); continue; }
    const shape = uniqueProofProblem(found);
    if (shape) throw new Error(`Generator produced an invalid proof (${shape}) for ${found.id}`);
    const brute = bruteForceProblem(found, opts.verifyBudget);
    if (brute === 'budget') { reject('verify-budget'); continue; }
    if (brute) throw new Error(`Independent search disagrees (${brute}) for ${found.id}`);
    out.puzzles.push(found);
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

export function minePuzzles(options: PuzzleMineOptions): PuzzleMineReport {
  const now = options.now ?? Date.now, started = now();
  const log = options.log ?? (() => undefined);
  const maxRemaining = options.maxRemaining ?? UNIQUE_PUZZLE_CRITERIA.maxRemaining;
  const nodeLimit = options.nodeLimit ?? 2_000_000, verifyBudget = options.verifyBudget ?? 3_000_000;
  const deadline = started + (options.budgetMinutes ?? 50) * 60_000;
  mkdirSync(options.state, { recursive: true, mode: 0o700 });
  const stateFile = join(options.state, 'mined.json');
  const out = options.out ?? join(options.state, 'bank.json');
  let state: State = { version: PUZZLE_MINER_VERSION, criteriaVersion: UNIQUE_PUZZLE_CRITERIA.version, maxRemaining, games: {} };
  if (existsSync(stateFile)) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
    // 기준이 바뀌면 처음부터 다시 발췌한다
    if (saved.version === PUZZLE_MINER_VERSION && saved.criteriaVersion === UNIQUE_PUZZLE_CRITERIA.version && saved.maxRemaining === maxRemaining) state = saved;
  }
  const archive = options.archive ? readArchive(options.archive) : [];
  const server = options.db ? readServerGames(options.db) : [];
  const all = [...archive, ...server];
  const pending = all.filter((g) => !state.games[g.id]);
  let newGames = 0;
  for (const game of pending) {
    if (now() > deadline) break;
    state.games[game.id] = mineGame(game, { nodeLimit, verifyBudget, maxRemaining });
    newGames++;
    if (newGames % 25 === 0) {
      writeAtomic(stateFile, JSON.stringify(state));
      log(`${newGames}/${pending.length} new games`);
    }
  }
  writeAtomic(stateFile, JSON.stringify(state));

  // 대칭 중복은 하나만. 같은 국면이 여러 대국에서 나오면 ID 순서로 먼저인 출처를 쓴다
  const known = new Set(all.map((g) => g.id));
  const unique = new Map<string, RecordPuzzleData>();
  const rejected: Record<string, number> = {};
  for (const [id, entry] of Object.entries(state.games).sort(([a], [b]) => a.localeCompare(b))) {
    if (!known.has(id)) continue;
    for (const [r, n] of Object.entries(entry.rejected)) rejected[r] = (rejected[r] ?? 0) + (n ?? 0);
    for (const p of entry.puzzles) if (!unique.has(p.id)) unique.set(p.id, p);
  }
  const puzzles = assignRatings([...unique.values()]);
  const version = digest(JSON.stringify(puzzles)).slice(0, 16);
  const sources = {
    archiveGames: archive.filter((g) => state.games[g.id]).length,
    serverGames: server.filter((g) => state.games[g.id]).length,
  };
  const bank: PuzzleBankFile = {
    schema: PUZZLE_BANK_SCHEMA, rule: RULE, version, generatedAt: new Date(now()).toISOString(),
    criteria: { ...UNIQUE_PUZZLE_CRITERIA, maxRemaining, solution: 'exactly one winning resulting board at every solver turn against every equally strong defense', verifiedBy: 'exhaustive minimax without pruning' },
    sources, puzzles,
  };
  if (puzzles.length) writeAtomic(out, JSON.stringify(bank));
  const floors = PUZZLE_SCALE.stageFloors;
  return {
    out, version, puzzles: puzzles.length, processedGames: Object.keys(state.games).filter((id) => known.has(id)).length,
    newGames, pendingGames: pending.length - newGames, sources, rejected,
    stages: floors.map((lo, i) => {
      const hi = floors[i + 1] ?? PUZZLE_SCALE.puzzleMax;
      return { n: i + 1, lo, hi, count: puzzles.filter((p) => p.rating >= lo && p.rating < hi).length };
    }),
    seconds: Math.round((now() - started) / 1000),
  };
}
