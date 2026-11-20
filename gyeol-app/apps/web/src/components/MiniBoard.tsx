import { useMemo } from 'react';
import { CELLS, N, bounds, dirOf, idx, initial, owner } from '@gyeol/core';
import { advance, startPosition } from '../game/track';
import { ARROW_INNER } from './tileArt';

/** 데일리 대국 미리보기: 지금 판을 5×5 안에 그리고, 마지막에 놓인 타일에 테두리 */
export function MiniBoard({ moves }: { moves: number[] }) {
  const { cells, last } = useMemo(() => {
    let p = startPosition(initial(), 1);
    for (const a of moves) p = advance(p, a);
    const [r0, r1, c0, c1] = bounds(p.board);
    const dr = r1 < 0 ? 0 : (5 - (r1 - r0 + 1)) / 2 - r0;
    const dc = c1 < 0 ? 0 : (5 - (c1 - c0 + 1)) / 2 - c0;
    const out: { r: number; c: number; g: boolean; dir: number; i: number }[] = [];
    for (let i = 0; i < CELLS; i++) {
      const v = p.board[i];
      if (!v) continue;
      out.push({ r: Math.floor(i / N) + dr, c: (i % N) + dc, g: owner(v) > 0, dir: dirOf(v), i });
    }
    const placed = p.last?.placed ? idx(...p.last.placed) : -1;
    return { cells: out, last: placed };
  }, [moves]);

  return (
    <span className="mboard" aria-hidden>
      {cells.map((x) => (
        <i
          key={x.i}
          className={`${x.g ? 'g' : 'b'} ${x.i === last ? 'last' : ''}`}
          style={{ left: `${2 + x.c * 19.5}%`, top: `${2 + x.r * 19.5}%` }}
        >
          <svg viewBox="0 0 100 100">
            <path transform={`rotate(${x.dir * 90 - 90} 50 50)`} d={ARROW_INNER} />
          </svg>
        </i>
      ))}
    </span>
  );
}
