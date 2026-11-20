/** 보정 파일럿의 표본은 둘 차례가 +1인 정규 보드다. 후반 국면에서 탐색 추정 승률이 실제(정확 증명) 승패에서 얼마나 떨어져 있는지 남은 타일 수별로 잰다. */
import { readFileSync } from 'node:fs';
import { ExactEndgame, type Player } from '../../packages/core/src/index';

interface Sample { board: number[]; player: Player; remaining: number; network: number; q: number; mean: number }
const games = readFileSync('tools/analysis/calibration-pilot/games.jsonl', 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s) as { samples: Sample[] });
const rows = new Map<number, { n: number; conf: number; wrongSide: number; solved: number }>();
const started = performance.now();
for (const game of games) for (const s of game.samples) {
  if (s.remaining < 4 || s.remaining > 9) continue;
  if (performance.now() - started > 240_000) break;
  let outcome: number;
  try { outcome = Math.sign(new ExactEndgame(400_000).value(s.board, 1, -1, 1)); } catch { continue; }
  if (outcome === 0) continue;
  // 둘 차례 쪽의 실제 승리 확률은 0 또는 1. 추정이 정답 쪽에 얼마나 확신하는지(0.5~1)를 본다.
  const p = (s.mean + 1) / 2, toward = outcome > 0 ? p : 1 - p;
  const row = rows.get(s.remaining) ?? { n: 0, conf: 0, wrongSide: 0, solved: 0 };
  row.n++; row.conf += toward; if (toward < 0.5) row.wrongSide++;
  rows.set(s.remaining, row);
}
console.log('remaining | positions | avg prob given to the proven winner (ideal 1.00) | estimate on the wrong side of 50%');
for (const [r, row] of [...rows].sort((a, b) => a[0] - b[0])) console.log(`${String(r).padStart(9)} | ${String(row.n).padStart(9)} | ${(row.conf / row.n).toFixed(2).padStart(6)} | ${(100 * row.wrongSide / row.n).toFixed(0)}%`);
