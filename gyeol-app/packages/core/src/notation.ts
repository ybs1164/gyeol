import {
  CELLS, LIMIT, N, PASS, TOTAL_TILES, bounds, decode, dirOf, initial, isLegal, legal, play,
  recenter, result, tileCount, type Board, type Player,
} from './rules';

export const NOTATION_RULE_VERSION = 'facing-25-v1' as const;
export const DIRECTION_LETTERS = ['u', 'r', 'd', 'l'] as const;
export type NotationErrorCode = 'format' | 'fields' | 'rules' | 'board' | 'center' | 'turn' | 'coordinate'
  | 'move' | 'case' | 'terminal' | 'illegal' | 'action' | 'mismatch' | 'length';

export class NotationError extends Error {
  constructor(public readonly code: NotationErrorCode, public readonly ply?: number) {
    super(`Invalid notation: ${code}${ply === undefined ? '' : ` (move ${ply})`}`);
    this.name = 'NotationError';
  }
}

export interface NotationPosition {
  board: Board;
  player: Player;
  ruleVersion?: typeof NOTATION_RULE_VERSION;
}
export interface NotationRecord {
  initialBoard?: Board;
  initialPlayer?: Player;
  ruleVersion?: typeof NOTATION_RULE_VERSION;
  moves: number[];
}
export interface ParsedNotationRecord extends NotationRecord {
  initialBoard: Board;
  initialPlayer: Player;
  ruleVersion: typeof NOTATION_RULE_VERSION;
}

function fail(code: NotationErrorCode): never { throw new NotationError(code); }
function bounded(text: string): string {
  if (typeof text !== 'string' || text.length > 16_384) fail('length');
  return text.trim();
}
function checkPlayer(player: Player): void { if (player !== 1 && player !== -1) fail('turn'); }
function checkPosition({ board, player, ruleVersion }: NotationPosition): void {
  checkPlayer(player);
  if (ruleVersion !== undefined && ruleVersion !== NOTATION_RULE_VERSION) fail('rules');
  if (!Array.isArray(board) || board.length !== CELLS
    || Array.from(board).some(v => !Number.isInteger(v) || Math.abs(v) > 4)) fail('board');
  const count = tileCount(board);
  const [r0, r1, c0, c1] = bounds(board);
  if (count < 2 || count > TOTAL_TILES || r1 - r0 >= LIMIT || c1 - c0 >= LIMIT) fail('board');
  if (recenter(board).shift.some(v => v !== 0)) fail('center');
}
function checkAction(board: Board, player: Player, action: number): void {
  checkPlayer(player);
  if (!Number.isInteger(action) || action < 0 || action > PASS) fail('action');
  if (result(board, player)) fail('terminal');
  if (!isLegal(board, player, action)) fail('illegal');
}

export function formatCell(r: number, c: number): string {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= N || c < 0 || c >= N) fail('coordinate');
  return `${'ABCDEFG'[c]}${r + 1}`;
}
export function parseCell(text: string): [number, number] {
  if (!/^[A-G][1-7]$/.test(text)) fail('coordinate');
  return [Number(text[1]) - 1, 'ABCDEFG'.indexOf(text[0])];
}

/** A short label describes placement relative to the rotated tile; rotation stays in the action. */
export function formatMove(board: Board, player: Player, action: number): string {
  checkAction(board, player, action);
  if (action === PASS) return player === 1 ? 'pass' : 'PASS';
  const m = decode(action)!;
  const direction = DIRECTION_LETTERS[m.side];
  return formatCell(m.r, m.c) + (player === 1 ? direction : direction.toUpperCase());
}

/**
 * 화면에 쓰는 수 번호. 양쪽 착수를 1부터 이어서 세고 패스는 세지 않는다(바둑식 통번호).
 * i번째 행동이 착수면 그 번호, 패스면 null. 저장하는 기보에는 번호가 없다.
 */
export function moveNumbers(actions: readonly number[]): (number | null)[] {
  let n = 0;
  return actions.map(a => a === PASS ? null : ++n);
}
/** 처음 at개의 행동 가운데 패스를 뺀 착수 수. */
export function movesPlayed(actions: readonly number[], at = actions.length): number {
  let n = 0;
  for (let i = 0; i < Math.min(at, actions.length); i++) if (actions[i] !== PASS) n++;
  return n;
}

/** Never choose an arbitrary rotation when a short label matches several actions. */
export function resolveMoveCandidates(board: Board, player: Player, text: string): number[] {
  checkPlayer(player);
  const label = bounded(text);
  if (result(board, player)) fail('terminal');
  if (label === 'pass' || label === 'PASS') {
    if (label !== (player === 1 ? 'pass' : 'PASS')) fail('case');
    if (!isLegal(board, player, PASS)) fail('illegal');
    return [PASS];
  }
  if (!/^[A-G][1-7][urdlURDL]$/.test(label)) fail('move');
  const direction = label[2];
  if ((direction === direction.toLowerCase()) !== (player === 1)) fail('case');
  const [r, c] = parseCell(label.slice(0, 2));
  const side = DIRECTION_LETTERS.indexOf(direction.toLowerCase() as typeof DIRECTION_LETTERS[number]);
  const candidates = legal(board, player).filter(a => {
    if (a === PASS) return false;
    const m = decode(a)!;
    return m.r === r && m.c === c && m.side === side;
  });
  if (!candidates.length) fail('illegal');
  return candidates;
}

export function formatPosition(position: NotationPosition): string {
  checkPosition(position);
  const rows = Array.from({ length: N }, (_, r) => position.board.slice(r * N, (r + 1) * N).map(v => {
    if (!v) return '.';
    const direction = DIRECTION_LETTERS[dirOf(v)];
    return v > 0 ? direction : direction.toUpperCase();
  }).join(''));
  return `GYEOL-P/1;rules=${NOTATION_RULE_VERSION};turn=${position.player === 1 ? 'lower' : 'upper'};board=${rows.join('/')}`;
}

function fields(parts: string[], expected: string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of parts) {
    const at = part.indexOf('=');
    const key = part.slice(0, at).trim();
    if (at < 0 || !expected.includes(key) || Object.hasOwn(out, key)) fail('fields');
    out[key] = part.slice(at + 1).trim();
  }
  if (expected.some(key => !Object.hasOwn(out, key))) fail('fields');
  return out;
}

export function parsePosition(text: string): Required<NotationPosition> {
  const [header, ...parts] = bounded(text).split(';');
  if (header !== 'GYEOL-P/1') fail('format');
  const data = fields(parts, ['rules', 'turn', 'board']);
  if (data.rules !== NOTATION_RULE_VERSION) fail('rules');
  if (data.turn !== 'lower' && data.turn !== 'upper') fail('turn');
  // Accept either slash-separated rows or a seven-line board pasted from the text preview.
  const raw = data.board.replace(/\r/g, '').trim();
  const rows = raw.includes('/') ? raw.split('/') : raw.split('\n').filter(row => row.trim());
  const clean = rows.map(row => row.replace(/\s/g, ''));
  if (clean.length !== N || clean.some(row => !/^[urdlURDL.]{7}$/.test(row))) fail('board');
  const board = clean.join('').split('').map(v => v === '.' ? 0
    : (v === v.toLowerCase() ? 1 : -1) * (DIRECTION_LETTERS.indexOf(v.toLowerCase() as typeof DIRECTION_LETTERS[number]) + 1));
  const position: Required<NotationPosition> = { board, player: data.turn === 'lower' ? 1 : -1, ruleVersion: NOTATION_RULE_VERSION };
  checkPosition(position);
  return position;
}

function replayRecord(record: NotationRecord): { start: Required<NotationPosition>; labels: string[] } {
  const start: Required<NotationPosition> = {
    board: record.initialBoard ?? initial(), player: record.initialPlayer ?? 1,
    ruleVersion: record.ruleVersion ?? NOTATION_RULE_VERSION,
  };
  checkPosition(start);
  if (!Array.isArray(record.moves) || record.moves.length > 64) fail('length');
  let board = start.board;
  let player = start.player;
  const labels: string[] = [];
  for (let i = 0; i < record.moves.length; i++) {
    try {
      const action = record.moves[i];
      labels.push(formatMove(board, player, action));
      board = play(board, player, action).board;
      player = -player as Player;
    } catch (error) {
      if (error instanceof NotationError) throw new NotationError(error.code, i + 1);
      throw error;
    }
  }
  return { start, labels };
}

export function formatRecord(record: NotationRecord): string {
  const { start, labels } = replayRecord(record);
  return `GYEOL-R/1\nstart=${formatPosition(start)}\nmoves=${labels.join(' ')}\nactions=${record.moves.join(' ')}`;
}

export function parseRecord(text: string): ParsedNotationRecord {
  const [header, ...lines] = bounded(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (header !== 'GYEOL-R/1') fail('format');
  const data = fields(lines, ['start', 'moves', 'actions']);
  const start = parsePosition(data.start);
  const labels = data.moves ? data.moves.split(/\s+/) : [];
  const actions = data.actions ? data.actions.split(/\s+/) : [];
  if (labels.length !== actions.length) fail('mismatch');
  if (actions.length > 64) fail('length');
  const moves = actions.map((a, i) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(a) || Number(a) > PASS) throw new NotationError('action', i + 1);
    return Number(a);
  });
  const record: ParsedNotationRecord = { initialBoard: start.board, initialPlayer: start.player, ruleVersion: start.ruleVersion, moves };
  const checked = replayRecord(record);
  checked.labels.forEach((label, i) => { if (label !== labels[i]) throw new NotationError('mismatch', i + 1); });
  return record;
}
