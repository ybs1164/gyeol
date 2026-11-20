import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 서버의 AI 1,000명 전체 대신 실측 기준점만 브라우저와 공유한다. */
export function syncPuzzleScale() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = JSON.parse(readFileSync(`${root}packages/server/src/bot-ratings.json`, 'utf8')) as {
    calibratedAt: string; activeProfileIds: string[]; profiles: { id: string; rating: number }[];
  };
  const measured = source.activeProfileIds.map((id) => {
    const profile = source.profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Missing AI anchor: ${id}`);
    return profile.rating;
  }).sort((a, b) => a - b);
  if (measured.length < 2 || measured.some((n, i) => !Number.isFinite(n) || (i > 0 && n <= measured[i - 1]))) throw new Error('Invalid AI rating scale');
  const floors = Array.from({ length: 8 }, (_, i) => {
    const pos = (i / 7) * (measured.length - 1);
    const lo = Math.min(measured.length - 2, Math.floor(pos));
    return Math.round(measured[lo] + (measured[lo + 1] - measured[lo]) * (pos - lo));
  });
  const scale = {
    version: 2,
    sourceCalibratedAt: source.calibratedAt,
    aiMin: measured[0], aiMax: measured[measured.length - 1],
    stageFloors: floors,
    puzzleMin: floors[0],
    puzzleMax: Math.ceil((floors[7] + (floors[7] - floors[6]) / 2) / 50) * 50,
    start: Math.round(floors[0] / 100) * 100,
    targetAccuracy: 0.65,
  };
  writeFileSync(`${root}packages/core/src/puzzle-scale.ts`, '// 자동 생성: npm run puzzles. AI 실측 기준점에 맞춘 퍼즐 점수 척도.\nexport const PUZZLE_SCALE = ' + JSON.stringify(scale, null, 2) + ' as const;\n');
  return scale;
}
