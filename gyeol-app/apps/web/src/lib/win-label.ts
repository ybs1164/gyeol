import type { WinPoint } from '@gyeol/ai';
import type { Player } from '@gyeol/core';
import { t } from '../i18n';

export type WinDistancePoint = { status: WinPoint['status'] | 'stable' } & Partial<Pick<WinPoint, 'source' | 'provenOutcome' | 'forcedWinPlies' | 'winDistanceKind'>>;

/** 단순 100% 추정이나 이미 끝난 종국에는 강제 승리 수를 표시하지 않는다. */
export function forcedWinLabel(point: WinDistancePoint | null | undefined, perspective: Player): string | null {
  if (!point || point.status !== 'exact' || point.source !== 'proven' || !point.provenOutcome
    || !['exact', 'upper-bound'].includes(point.winDistanceKind ?? '')
    || !Number.isInteger(point.forcedWinPlies) || point.forcedWinPlies! < 1) return null;
  return t(point.provenOutcome === perspective ? 'win.inMoves' : 'win.lossInMoves', { n: point.forcedWinPlies! });
}
