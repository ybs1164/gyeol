import { positionKey } from './endgame';
import { PUZZLE_SCALE } from './puzzle-scale';
import { pick } from './random';
import { result, type Board, type Player } from './rules';
import type { RecordKind, RecordPuzzleData } from './record-types';
import { uniqueProofProblem } from './unique-puzzle';

export type RatedKind = RecordKind;
export type RatedPuzzle = RecordPuzzleData;
export const RATED_KINDS: RatedKind[] = ['advantage', 'turnaround', 'win'];
export const KIND_RANGE: Record<RatedKind, [number, number]> = {
  advantage: [PUZZLE_SCALE.puzzleMin, PUZZLE_SCALE.puzzleMax],
  turnaround: [PUZZLE_SCALE.puzzleMin, PUZZLE_SCALE.puzzleMax],
  win: [PUZZLE_SCALE.puzzleMin, PUZZLE_SCALE.puzzleMax],
};
export interface BankEntry { id: string; kind: RatedKind; rating: number }
/** 서버가 내려주는 퍼즐 은행 파일(GET /api/puzzles). */
export interface PuzzleBankFile {
  schema: 1;
  rule: string;
  version: string;
  generatedAt: string;
  criteria: Record<string, unknown>;
  sources: Record<string, number>;
  puzzles: RatedPuzzle[];
}
export const PUZZLE_BANK_SCHEMA = 1;
let loaded: RatedPuzzle[] = [];
let loadedVersion: string | null = null;
let byId = new Map<string, RatedPuzzle>();
let bank: BankEntry[] = [];
const proofs = new WeakMap<RatedPuzzle, Map<string, [number, number][]>>();

/**
 * 서버에서 받은 은행을 쓴다. 정답이 하나뿐이라는 조건을 저장된 풀이로 다시 확인하고, 어긋난 문제는 버린다.
 * 받아들인 문제 수를 돌려준다.
 */
export function loadPuzzleBank(file: PuzzleBankFile): number {
  if (file?.schema !== PUZZLE_BANK_SCHEMA || !Array.isArray(file.puzzles)) throw new Error('알 수 없는 퍼즐 은행 형식');
  const accepted = file.puzzles.filter((p) => p && typeof p.id === 'string' && p.id.startsWith('rp-') && RATED_KINDS.includes(p.kind) && !uniqueProofProblem(p));
  if (!accepted.length) throw new Error('검증된 퍼즐이 없습니다');
  loaded = accepted;
  loadedVersion = file.version;
  byId = new Map(accepted.map((p) => [p.id, p]));
  bank = accepted.map(({ id, kind, rating }) => ({ id, kind, rating })).sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
  return accepted.length;
}
export const puzzleBankVersion = (): string | null => loadedVersion;
export const loadedPuzzles = (): readonly RatedPuzzle[] => loaded;

export function ratedBank(): BankEntry[] {
  if (!bank.length) throw new Error('퍼즐 은행을 아직 받지 않았습니다');
  return bank;
}
export function ratedPuzzle(id: string): RatedPuzzle | null {
  return byId.get(id) ?? null;
}

/** 추정값으로 대체하지 않고 종국까지 검증해 저장한 값만 쓴다. */
export function puzzleValues(puzzle: RatedPuzzle, board: Board, player: Player): Map<number, number> {
  if (result(board, player)) return new Map();
  let proof = proofs.get(puzzle);
  if (!proof) { proof = new Map(puzzle.proof); proofs.set(puzzle, proof); }
  const values = proof.get(positionKey(board, player));
  if (!values) throw new Error('검증된 풀이 수순에 없는 국면입니다');
  return new Map(values);
}

/** 마지막 승패가 양수인 수만 정답이다. 뒤집는 장수는 판정에 사용하지 않는다. */
export function correctMoves(_kind: RatedKind, values: Map<number, number>): number[] {
  return [...values].filter(([, v]) => v > 0).map(([a]) => a);
}

/** 종국 결과를 기준으로 가장 강하게 막는 응수. */
export function bestReply(puzzle: RatedPuzzle, board: Board, player: Player): number {
  const values = puzzleValues(puzzle, board, player);
  const best = Math.max(...values.values());
  const action = [...values].find(([, v]) => v === best)?.[0];
  if (action === undefined) throw new Error('응수할 수 없는 국면입니다');
  return action;
}

export function pickRated(target: number, seen: ReadonlySet<string>, random: () => number = Math.random, stageN?: number): BankEntry {
  if (!Number.isFinite(target)) target = PUZZLE_START;
  const stage = stageN ? PUZZLE_STAGES[stageN - 1] : null;
  if (stageN && !stage) throw new Error('없는 퍼즐 단계');
  const [lo, hi] = stage ? stageBand(stage) : [-Infinity, Infinity];
  const scoped = ratedBank().filter((e) => e.rating >= lo && e.rating < hi && (!stage || stage.kinds.includes(e.kind)));
  if (!scoped.length) throw new Error('검증된 실전 문제가 없습니다');
  const unseen = scoped.filter((e) => !seen.has(e.id));
  const candidates = unseen.length ? unseen : scoped;
  const distance = Math.min(...candidates.map((e) => Math.abs(e.rating - target)));
  return pick(candidates.filter((e) => Math.abs(e.rating - target) <= Math.max(50, distance + 25)), random);
}

export const PUZZLE_START = PUZZLE_SCALE.start;
/** 4: 서버가 내려주는 정답 하나짜리 은행 */
export const PUZZLE_BANK_VERSION = 4;
export function recommendedPuzzleRating(rating: number, random: () => number = Math.random): number {
  const offset = 400 * Math.log10(PUZZLE_SCALE.targetAccuracy / (1 - PUZZLE_SCALE.targetAccuracy));
  return Math.round(Math.max(PUZZLE_SCALE.puzzleMin, Math.min(PUZZLE_SCALE.puzzleMax - 1, rating - offset + (random() - 0.5) * 60)));
}
export function puzzleStartForGame(rating?: number, ranked = 0): number {
  return ranked >= 5 && rating !== undefined && Number.isFinite(rating)
    ? Math.round(Math.max(PUZZLE_SCALE.puzzleMin, Math.min(PUZZLE_SCALE.puzzleMax, rating))) : PUZZLE_START;
}
export function migratePuzzleRating(rating: number): number {
  if (!Number.isFinite(rating)) return PUZZLE_START;
  const old = [400, 650, 900, 1150, 1400, 1650, 1900, 2150, 2500];
  const next: number[] = [...PUZZLE_SCALE.stageFloors, PUZZLE_SCALE.puzzleMax];
  let i = 0;
  while (i < old.length - 2 && rating > old[i + 1]) i++;
  return Math.max(100, Math.round(next[i] + ((rating - old[i]) / (old[i + 1] - old[i])) * (next[i + 1] - next[i])));
}
export function ratingDelta(mine: number, puzzle: number, solved: boolean, played: number): number {
  const k = Math.max(16, 48 - 2 * played);
  const d = Math.round(k * ((solved ? 1 : 0) - 1 / (1 + 10 ** ((puzzle - mine) / 400))));
  return solved ? Math.max(1, d) : Math.min(-1, d);
}
export interface PuzzleStage { n: number; min: number; kinds: RatedKind[] }
export const PUZZLE_STAGES: PuzzleStage[] = PUZZLE_SCALE.stageFloors.map((min, i) => ({
  n: i + 1, min: i === 0 ? -Infinity : min, kinds: [...RATED_KINDS],
}));
export function stageOf(rating: number): PuzzleStage {
  for (let i = PUZZLE_STAGES.length - 1; i >= 0; i--) if (rating >= PUZZLE_STAGES[i].min) return PUZZLE_STAGES[i];
  return PUZZLE_STAGES[0];
}
export function stageBand(s: PuzzleStage): [number, number] {
  return [Number.isFinite(s.min) ? s.min : PUZZLE_SCALE.puzzleMin, PUZZLE_STAGES[s.n]?.min ?? PUZZLE_SCALE.puzzleMax];
}
