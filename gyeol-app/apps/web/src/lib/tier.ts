import { PLACEMENT_GAMES } from '@gyeol/core';
export { PLACEMENT_GAMES } from '@gyeol/core';

/** 티어 = 레이팅 구간. 제한 없이 평가된 랭크전 5판 전에는 배치 중 */
export type TierId = 'place' | 'bronze' | 'silver' | 'gold' | 'plat' | 'dia' | 'master';

/** 높은 티어부터. min 이상이면 그 티어 */
export const TIERS: { id: Exclude<TierId, 'place'>; min: number }[] = [
  { id: 'master', min: 1900 },
  { id: 'dia', min: 1750 },
  { id: 'plat', min: 1600 },
  { id: 'gold', min: 1500 },
  { id: 'silver', min: 1300 },
  { id: 'bronze', min: -Infinity },
];

export function tierOf(rating: number, ranked: number, bot = false): TierId {
  if (!bot && ranked < PLACEMENT_GAMES) return 'place';
  return TIERS.find((x) => rating >= x.min)!.id;
}

/** 다음 티어와 남은 점수, 진행률(0..1). 최고 티어나 배치 중이면 null */
export function nextTier(rating: number, ranked: number): { id: TierId; min: number; left: number; progress: number } | null {
  const cur = tierOf(rating, ranked);
  if (cur === 'place' || cur === 'master') return null;
  const i = TIERS.findIndex((x) => x.id === cur);
  const next = TIERS[i - 1];
  const floor = Number.isFinite(TIERS[i].min) ? TIERS[i].min : next.min - 200;
  const progress = Math.max(0, Math.min(1, (rating - floor) / (next.min - floor)));
  return { id: next.id, min: next.min, left: Math.max(0, Math.ceil(next.min - rating)), progress };
}

/** 배지에 쓰는 머리글자 */
export const TIER_MARK: Record<TierId, string> = {
  place: '?', bronze: 'B', silver: 'S', gold: 'G', plat: 'P', dia: 'D', master: 'M',
};
