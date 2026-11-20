import type { ReactNode } from 'react';
import { counts, type Board, type Player } from '@gyeol/core';
import { sideName } from '../lib/skins';

interface Props {
  board: Board;
  turn: Player | null;
  names?: { green: ReactNode; brown: ReactNode };
}

export function Score({ board, turn, names }: Props) {
  const { green, brown } = counts(board);
  return (
    <div className="scorebar" aria-live="polite">
      <div className={`side ${turn === 1 ? 'turn' : ''}`}>
        <span className="chip g" />
        <span className="side-name">{names?.green ?? sideName(1)}</span>
        <span className="num">{green}</span>
      </div>
      <div className={`side ${turn === -1 ? 'turn' : ''}`}>
        <span className="chip b" />
        <span className="side-name">{names?.brown ?? sideName(-1)}</span>
        <span className="num">{brown}</span>
      </div>
    </div>
  );
}
