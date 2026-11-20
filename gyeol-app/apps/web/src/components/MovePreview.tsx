import { useState } from 'react';
import { decode, formatCell, formatMove, idx, type Player } from '@gyeol/core';
import { advance, type Position } from '../game/track';
import { Board } from './Board';
import { t } from '../i18n';
import { Popup } from './ui';

export function moveDescription(player: Player, action: number): string {
  const m = decode(action);
  const color = t(player === 1 ? 'notation.first' : 'notation.second');
  return m ? t('notation.description', { color, cell: formatCell(m.r, m.c), dir: t(`dir.${m.side}`) }) : `${color}: ${t('rp.pass')}`;
}

export function MovePreview({ before, action, ply, onClose }: { before: Position; action: number; ply: number; onClose: () => void }) {
  const [after, setAfter] = useState(false);
  const m = decode(action);
  const pos = after ? advance(before, action) : { ...before, animate: false };
  return <Popup onClose={onClose} className="move-preview">
    <h3>{ply}. <span className="move-code">{formatMove(before.board, before.player, action)}</span></h3>
    <p className="small">{t(after ? 'notation.after' : 'notation.before', { n: ply })}</p>
    <Board pos={pos} interactive={false} showCoordinates showLast={after}
      marks={!after && m ? [idx(m.r, m.c)] : []} ghost={!after && m ? { cell: idx(m.pr, m.pc), player: before.player, dir: m.placeDir } : null} />
    <div className="actions"><button className="btn" onClick={() => setAfter(!after)}>{t(after ? 'review.prev' : 'notation.apply')}</button>
      <button className="btn" onClick={onClose}>{t('notation.close')}</button></div>
  </Popup>;
}
