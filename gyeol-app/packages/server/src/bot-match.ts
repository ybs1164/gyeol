/** 가까운 레이팅 안에서 섞되, 범위 밖 사람에게도 가장 가까운 AI를 고른다. */
export function selectBot(
  pool: { id: string; rating: number }[], rating: number,
  recent: string[] = [], random: () => number = Math.random,
): string {
  if (!pool.length) throw new Error('AI 목록이 비었습니다');
  const nearest = Math.min(...pool.map((p) => Math.abs(p.rating - rating)));
  const nearby = pool.filter((p) => Math.abs(p.rating - rating) <= nearest + 100);
  const fresh = nearby.filter((p) => !recent.includes(p.id));
  const candidates = fresh.length ? fresh : nearby;
  const minDistance = Math.min(...candidates.map((p) => Math.abs(p.rating - rating)));
  const weights = candidates.map((p) => Math.exp(-((p.rating - rating) ** 2 - minDistance ** 2) / (2 * 60 ** 2)));
  let draw = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < candidates.length; i++) if ((draw -= weights[i]) < 0) return candidates[i].id;
  return candidates[candidates.length - 1].id;
}
