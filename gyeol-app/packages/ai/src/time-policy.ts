import { TOTAL_TILES, tileCount, type Board, type TimeMode } from '@gyeol/core';

export interface CognitiveTimeBudget { softMs: number; hardMs: number; reserveMs: number }
export function cognitiveTimeBudget(board: Board, mode: TimeMode, leftMs: number, complexity = 1): CognitiveTimeBudget {
  if (!Number.isFinite(leftMs) || leftMs < 0 || !Number.isFinite(complexity) || complexity < 0) throw new Error('Invalid time budget');
  const reserveMs = Math.min(leftMs * 0.25, Math.max(250, leftMs * 0.01));
  const safe = Math.max(0, leftMs - reserveMs);
  const cap = mode === 'bullet' ? 4000 : mode === 'blitz' ? 10000 : 15000;
  const remainingTurns = Math.max(1, Math.ceil((TOTAL_TILES - tileCount(board)) / 2));
  const base = mode === 'daily' ? 3500 : safe / (remainingTurns + 1);
  return { softMs: Math.min(safe, cap, base * Math.min(1.5, Math.max(0.1, complexity))),
    hardMs: Math.min(safe, cap), reserveMs };
}
