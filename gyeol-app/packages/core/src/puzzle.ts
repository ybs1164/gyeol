import { apply, legal, PASS, type Board, type Player } from './rules';
import { loadedPuzzles } from './rated';
import type { RecordPuzzleData } from './record-types';

export interface Puzzle extends RecordPuzzleData { key: string; number: number }
export const PUZZLE_EPOCH = '2026-11-10';
export function dateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function puzzleNumber(key: string): number {
  const day = (k: string) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  return Math.round(day(key) - day(PUZZLE_EPOCH)) + 1;
}
/** 규칙 분석 도구용. 퍼즐의 목표나 정답 판정에는 사용하지 않는다. */
export function captureCounts(b: Board, p: Player): Map<number, number> {
  return new Map(legal(b, p).filter((a) => a !== PASS).map((a) => [a, apply(b, p, a).last.flipped?.length ?? 0]));
}
/** 서버에서 받은 은행을 한 번씩 순환한다. 풀기 시작한 ID는 저장소에서 고정한다. */
export function dailyPuzzle(key: string = dateKey(), pinnedId?: string): Puzzle {
  const sorted = [...loadedPuzzles()].sort((a, b) => a.id.localeCompare(b.id));
  if (!sorted.length) throw new Error('검증된 실전 퍼즐이 없습니다');
  const number = puzzleNumber(key);
  const puzzle = sorted.find((p) => p.id === pinnedId) ?? sorted[((number - 1) % sorted.length + sorted.length) % sorted.length];
  return { ...puzzle, key, number };
}
