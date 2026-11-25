import { useState } from 'react';
import { decode, formatCell, formatMove, idx, type Player } from '@gyeol/core';
import { advance, type Position } from '../game/track';
import { Board } from './Board';
import { t } from '../i18n';
import { Popup } from './ui';

/** 수 번호 표기: 선공은 `12.`, 후공은 `12...` */
export const moveNumberLabel = (n: number, player: Player) => `${n}${player === 1 ? '.' : '...'}`;

export function moveDescription(player: Player, action: number): string {
  const m = decode(action);
  const color = t(player === 1 ? 'notation.first' : 'notation.second');
  return m ? t('notation.description', { color, cell: formatCell(m.r, m.c), dir: t(`dir.${m.side}`) }) : `${color}: ${t('rp.pass')}`;
}

/** number: 패스를 세지 않는 수 번호. 패스면 null. */
export function MovePreview({ before, action, number, onClose }: { before: Position; action: number; number: number | null; onClose: () => void }) {
  const [after, setAfter] = useState(false);
  const m = decode(action);
  const pos = after ? advance(before, action) : { ...before, animate: false };
  return <Popup onClose={onClose} className="move-preview">
    <h3>{number === null ? moveDescription(before.player, action) : <>{moveNumberLabel(number, before.player)} <span className="move-code">{formatMove(before.board, before.player, action)}</span></>}</h3>
    {number !== null && <p className="small">{t(after ? 'notation.after' : 'notation.before', { n: number })}</p>}
    <Board pos={pos} interactive={false} showCoordinates showLast={after}
      marks={!after && m ? [idx(m.r, m.c)] : []} ghost={!after && m ? { cell: idx(m.pr, m.pc), player: before.player, dir: m.placeDir } : null} />
    <div className="actions"><button className="btn" onClick={() => setAfter(!after)}>{t(after ? 'review.prev' : 'notation.apply')}</button>
      <button className="btn" onClick={onClose}>{t('notation.close')}</button></div>
  </Popup>;
}
