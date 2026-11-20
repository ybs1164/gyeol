import { dateKey } from '@gyeol/core';
import { puzzleLog } from './storage';

/** 오늘(또는 오늘 아직 안 풀었으면 어제)까지 연속으로 푼 날 수 */
export function streak(today: Date = new Date()): number {
  const log = puzzleLog.all();
  const d = new Date(today);
  if (!log[dateKey(d)]?.solved) d.setDate(d.getDate() - 1);
  let n = 0;
  while (log[dateKey(d)]?.solved) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function solvedCount(): number {
  return Object.values(puzzleLog.all()).filter((d) => d.solved).length;
}
