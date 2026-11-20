import type { RatingPoint } from '@gyeol/core';

/** 기준 기록이 삭제된 기간의 변화를 1500에서 추측하지 않는다. */
export function weekDelta(points: RatingPoint[], current: number, complete = false, now = Date.now()): number | null {
  const cutoff = now - 7 * 86_400_000;
  const before = points.filter((p) => p.at <= cutoff).at(-1);
  const base = before ?? (complete ? points[0] : undefined);
  return base ? current - base.rating : null;
}

/** 기간 직전의 마지막 점수에서 시작하며, 실제 시각 간격으로 그릴 수 있게 한다. */
export function ratingWindow(points: RatingPoint[], days: number, now = Date.now()): RatingPoint[] {
  if (!points.length) return [];
  const from = days ? now - days * 86_400_000 : points[0].at;
  const before = points.filter((p) => p.at < from).at(-1);
  const inside = points.filter((p) => p.at >= from);
  const window = before ? [{ at: from, rating: before.rating }, ...inside] : [...inside];
  const last = window.at(-1);
  if (last && last.at < now) window.push({ at: now, rating: last.rating });
  return window;
}
