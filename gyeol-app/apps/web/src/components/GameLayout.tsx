import { useEffect, useRef, type ReactNode } from 'react';
import { apply, formatMove, initial, moveNumbers, type Board, type Player } from '@gyeol/core';
import { moveDescription, moveNumberLabel } from './MovePreview';
import { Icon } from './Icon';
import { useLayout } from '../lib/layout';
import { t } from '../i18n';

interface Props {
  /** .screen 에 덧붙일 클래스 (예: 'game') */
  className?: string;
  /** 위쪽 막대 */
  top: ReactNode;
  /** 판 위 (상대 줄 · 점수 · 설명) */
  above?: ReactNode;
  board: ReactNode;
  /** 판 아래 (내 줄 · 상태 · 결과) */
  below?: ReactNode;
  /** 넓은 창에서만 보이는 것 (수순 등) */
  side?: ReactNode;
  /** 좁은 화면에서 펼쳐 보는 수순 */
  moves?: ReactNode;
  /** 맨 아래 버튼들 */
  footer?: ReactNode;
  /** 팝업 · 토스트 */
  overlay?: ReactNode;
  /** 좁은 화면에서 위아래 여백으로 판을 가운데쯤에 둔다 (대국 화면) */
  centered?: boolean;
}

/**
 * 판이 있는 화면의 틀.
 * 좁음·중간: 위 막대 → 판 위 → 판 → 판 아래 → 버튼 (지금까지와 같은 순서와 DOM).
 * 넓음: 판은 왼쪽, 나머지는 오른쪽 패널.
 */
export function GameLayout({ className, top, above, board, below, side, moves, footer, overlay, centered = false }: Props) {
  const layout = useLayout();
  const cls = className ? `screen ${className}` : 'screen';

  if (layout === 'expanded')
    return (
      <div className={`${cls} game-wide`}>
        {top}
        <div className="gw-body">
          <div className="gw-board">{board}</div>
          <div className="gw-side">
            {above}
            {side}
            {below}
            <div className="spacer" />
            {footer}
          </div>
        </div>
        {overlay}
      </div>
    );

  return (
    <div className={cls}>
      {top}
      {centered && <div className="spacer" />}
      {above}
      {board}
      {below}
      {moves && <details className="mobile-moves"><summary><span>{t('notation.moveList')}</span><Icon name="chevron" /></summary>{moves}</details>}
      <div className="spacer" style={centered ? { flex: 1.4 } : undefined} />
      {footer}
      {overlay}
    </div>
  );
}

export interface MoveEntry {
  player: Player;
  notation: string;
  action: number;
}

/** 처음 판에서 둔 수들을 다시 두어 수순 목록을 만든다 (온라인 대국용) */
export function movesFromActions(actions: number[], first: Player = 1, start: Board = initial()): MoveEntry[] {
  let board: Board = start;
  let player = first;
  return actions.map((a) => {
    const r = apply(board, player, a);
    const entry = { player, notation: formatMove(board, player, a), action: a };
    board = r.board;
    player = -player as Player;
    return entry;
  });
}

/** 각 열은 해당 플레이어의 수만 담는다. 번호는 양쪽 착수를 이어서 센 통번호이고 패스에는 번호가 없다. 필터를 적용해도 원래 번호를 유지한다. */
export function MoveList({ moves, onSelect, selectedIndex = moves.length - 1, visibleIndices, renderDetail }: {
  moves: MoveEntry[]; onSelect?: (index: number) => void; selectedIndex?: number;
  visibleIndices?: number[]; renderDetail?: (index: number) => ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scroll.current;
    const active = box?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!box || !active) return;
    const area = box.getBoundingClientRect(), cell = active.getBoundingClientRect();
    if (cell.bottom > area.bottom) box.scrollTop += cell.bottom - area.bottom;
    else if (cell.top < area.top + 20) box.scrollTop += cell.top - area.top - 20;
  }, [moves.length, selectedIndex, visibleIndices]);
  const numbers = moveNumbers(moves.map(move => move.action));
  const columns = ([1, -1] as const).map(player => moves.map((move, index) => ({ move, index })).filter(entry => entry.move.player === player));
  const visible = (index: number) => !visibleIndices || visibleIndices.includes(index);
  const rows = Array.from({ length: Math.max(...columns.map(column => column.length)) }, (_, i) => columns.map(column => column[i]));
  return (
    <section className="move-log" aria-label={t('game.moves')}>
      <div className="move-table-scroll" ref={scroll}><table className="move-table">
        <thead><tr><th scope="col">{t('notation.first')}</th><th scope="col">{t('notation.second')}</th></tr></thead>
        <tbody>{rows.filter(row => row.some(entry => entry && visible(entry.index))).map((row, rowIndex) => <tr key={rowIndex}>
          {row.map((entry, column) => <td key={column}>{entry && visible(entry.index) && <button
            className="move-notation" disabled={!onSelect} onClick={() => onSelect?.(entry.index)} data-ply={entry.index + 1}
            aria-current={entry.index === selectedIndex ? 'step' : undefined} aria-label={numbers[entry.index] === null ? moveDescription(entry.move.player, entry.move.action) : `${numbers[entry.index]}. ${moveDescription(entry.move.player, entry.move.action)}`}>
            <span className="move-number">{numbers[entry.index] === null ? '' : moveNumberLabel(numbers[entry.index]!, entry.move.player)}</span><span className="move-code">{numbers[entry.index] === null ? t('rp.pass') : entry.move.notation}</span>
            {renderDetail && <span className="move-cell-detail">{renderDetail(entry.index)}</span>}
          </button>}</td>)}
        </tr>)}</tbody>
      </table></div>
    </section>
  );
}
