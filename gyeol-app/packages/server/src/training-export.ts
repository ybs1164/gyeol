/**
 * P1: 끝난 온라인 대국(사람끼리, 사람 대 서버 봇)을 학습 국면 JSONL로 내보낸다.
 *
 * - 운영 DB를 읽기 전용으로 연다. 쓰기·마이그레이션·pragma 변경을 하지 않는다.
 * - 출력에는 닉네임·계정 ID·토큰·시각이 없다. 수를 둘 쪽이 사람인지 봇인지만 남긴다.
 * - 승패는 내보내지 않는다. 사람의 승패는 국면의 정답이 아니며, 정답은 P2 재분석이 만든다.
 * - 같은 국면(8대칭·색 맞바꿈 포함)은 한 번만 내보내고, 얼린 시험 세트 국면은 내보내지 않는다.
 * - 한 사람이 분포를 끌고 가지 않도록 사람별 국면 수에 상한을 둔다. 사람 구분은 서버에만 있는
 *   비밀 salt 로 만든 HMAC 이며 state 파일에만 남는다(출력 파일에는 없음).
 *
 * 상태(out 폴더, 서버 밖으로 옮기지 않는다):
 *   state.json      커서(마지막으로 읽은 finished_at,id), salt, 사람별 개수, 누적 통계
 *   seen-keys.txt   이미 내보낸 대칭 키의 sha256 앞 16자(한 줄에 하나)
 *   positions-<run>-<time>.jsonl  실행마다 새 파일
 */
import Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASS, TOTAL_TILES, apply, initial, legal, result, symmetryKey, tileCount, type Board, type Player } from '@gyeol/core';

export const TRAINING_EXPORT_VERSION = 1;
const RULE = 'facing-25-v1';

export interface TrainingExportOptions {
  db: string;
  out: string;
  /** 얼린 시험 세트 JSONL(board, player 필드). 이 국면들은 내보내지 않는다. */
  exclude: string[];
  /** 사람 한 명이 둘 차례인 국면의 누적 상한 */
  playerCap?: number;
  /** 이보다 짧은 대국은 버린다 */
  minPlies?: number;
  /** 한 번에 읽을 대국 수 상한(0 = 전부) */
  maxGames?: number;
  now?: () => Date;
}
export interface TrainingPosition {
  v: number;
  rule: string;
  board: Board;
  player: Player;
  remaining: number;
  ply: number;
  mode: string;
  ranked: boolean;
  /** 이 국면에서 둘 쪽과 상대가 사람인지 봇인지 */
  mover: 'human' | 'bot';
  opponent: 'human' | 'bot';
}
interface State {
  version: number;
  cursor: { finishedAt: number; id: string } | null;
  salt: string;
  players: Record<string, number>;
  totals: { runs: number; games: number; positions: number };
}
export interface TrainingExportReport {
  file: string | null;
  games: { read: number; exported: number; invalid: number; short: number };
  positions: { written: number; duplicate: number; testSet: number; playerCap: number; forcedPass: number };
  cursor: State['cursor'];
  totals: State['totals'];
}

const digest = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

function loadState(out: string): State {
  const file = join(out, 'state.json');
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8')) as State;
    if (state.version !== TRAINING_EXPORT_VERSION) throw new Error(`Unknown training export state version ${state.version}`);
    return state;
  }
  return { version: TRAINING_EXPORT_VERSION, cursor: null, salt: randomBytes(32).toString('hex'), players: {}, totals: { runs: 0, games: 0, positions: 0 } };
}
function writePrivate(file: string, text: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

export function exportTrainingPositions(options: TrainingExportOptions): TrainingExportReport {
  const { out, playerCap = 5000, minPlies = 3, maxGames = 0 } = options;
  if (!options.exclude.length) throw new Error('At least one frozen test set must be excluded (--exclude)');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const state = loadState(out);
  const seenFile = join(out, 'seen-keys.txt');
  const seen = new Set(existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n').filter(Boolean) : []);
  const excluded = new Set<string>();
  for (const path of options.exclude) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as { board: Board; player: Player };
      excluded.add(digest(symmetryKey(row.board, row.player)));
    }
  }

  const db = new Database(options.db, { readonly: true, fileMustExist: true });
  const report: TrainingExportReport = {
    file: null,
    games: { read: 0, exported: 0, invalid: 0, short: 0 },
    positions: { written: 0, duplicate: 0, testSet: 0, playerCap: 0, forcedPass: 0 },
    cursor: state.cursor, totals: state.totals,
  };
  const lines: string[] = [], newKeys: string[] = [];
  try {
    const cursor = state.cursor ?? { finishedAt: -1, id: '' };
    const games = db.prepare(`SELECT id, mode, ranked, green_id, brown_id, initial_board_json, initial_player, finished_at
      FROM games WHERE status='finished' AND rule_version=? AND (finished_at > ? OR (finished_at = ? AND id > ?))
      ORDER BY finished_at, id ${maxGames > 0 ? 'LIMIT ?' : ''}`)
      .all(...[RULE, cursor.finishedAt, cursor.finishedAt, cursor.id, ...(maxGames > 0 ? [maxGames] : [])]) as Record<string, any>[];
    const movesOf = db.prepare('SELECT action FROM game_moves WHERE game_id=? ORDER BY ply').pluck();
    const isBot = db.prepare('SELECT is_bot FROM players WHERE id=?').pluck();
    for (const g of games) {
      report.games.read++;
      state.cursor = { finishedAt: g.finished_at, id: g.id };
      const moves = movesOf.all(g.id) as number[];
      if (moves.length < minPlies) { report.games.short++; continue; }
      let board: Board = JSON.parse(g.initial_board_json), player = g.initial_player as Player;
      if (!Array.isArray(board) || board.length !== initial().length) { report.games.invalid++; continue; }
      const kind = (id: string | null): 'human' | 'bot' => (id && isBot.get(id) === 1 ? 'bot' : 'human');
      const side = { 1: { id: g.green_id as string, kind: kind(g.green_id) }, [-1]: { id: g.brown_id as string, kind: kind(g.brown_id) } } as const;
      const rows: TrainingPosition[] = [], keys: string[] = [];
      let valid = true;
      for (let ply = 0; ply < moves.length; ply++) {
        const options = legal(board, player);
        if (!options.includes(moves[ply])) { valid = false; break; }
        if (options.length === 1 && options[0] === PASS) report.positions.forcedPass++;
        else {
          const key = digest(symmetryKey(board, player));
          const mover = side[player], tag = mover.kind === 'human' ? createHmac('sha256', state.salt).update(mover.id).digest('hex').slice(0, 24) : null;
          if (excluded.has(key)) report.positions.testSet++;
          else if (seen.has(key)) report.positions.duplicate++;
          else if (tag && (state.players[tag] ?? 0) >= playerCap) report.positions.playerCap++;
          else {
            seen.add(key); keys.push(key);
            if (tag) state.players[tag] = (state.players[tag] ?? 0) + 1;
            rows.push({ v: TRAINING_EXPORT_VERSION, rule: RULE, board, player, remaining: TOTAL_TILES - tileCount(board), ply: ply + 1,
              mode: g.mode, ranked: g.ranked === 1, mover: mover.kind, opponent: side[-player as Player].kind });
          }
        }
        board = apply(board, player, moves[ply]).board; player = -player as Player;
        if (result(board, player) && ply < moves.length - 1) { valid = false; break; }
      }
      if (!valid) {
        // 이 대국에서 세운 키·개수는 되돌린다
        report.games.invalid++;
        for (const k of keys) seen.delete(k);
        for (const r of rows) if (r.mover === 'human') {
          const tag = createHmac('sha256', state.salt).update(side[r.player].id).digest('hex').slice(0, 24);
          state.players[tag]--;
        }
        continue;
      }
      report.games.exported++;
      for (const r of rows) lines.push(JSON.stringify(r));
      newKeys.push(...keys);
    }
  } finally { db.close(); }

  report.positions.written = lines.length;
  if (lines.length) {
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const file = join(out, `positions-${String(state.totals.runs + 1).padStart(6, '0')}-${stamp}.jsonl`);
    if (existsSync(file)) throw new Error(`${file} already exists`);
    writePrivate(file, lines.join('\n') + '\n');
    report.file = file;
    // 위치 파일 → 본 키 → 상태 순서. 중간에 멈추면 다음 실행에서 국면이 빠지지 않고 중복될 수만 있다.
    appendFileSync(seenFile, newKeys.join('\n') + '\n', { mode: 0o600 });
  }
  state.totals = { runs: state.totals.runs + 1, games: state.totals.games + report.games.exported, positions: state.totals.positions + lines.length };
  writePrivate(join(out, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  report.cursor = state.cursor; report.totals = state.totals;
  return report;
}
