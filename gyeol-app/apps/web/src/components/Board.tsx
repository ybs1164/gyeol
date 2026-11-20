import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { CELLS, DIRS, N, PASS, bounds, canPlaceAt, decode, dirOf, formatCell, idx, legal, owner, type Dir } from '@gyeol/core';
import type { ReviewType } from '../lib/move-types';
import type { Position } from '../game/track';
import { t } from '../i18n';
import { sideName } from '../lib/skins';
import { settings } from '../lib/storage';
import { ARROW_INNER } from './tileArt';
import { MoveTypeBadge } from './MoveTypeBadge';

/** 화살표: MDF 타일처럼 윤곽 홈만 선 색(currentColor), 안쪽은 면 색 그대로. angle 0 = 위 */
export function Arrow({ angle = 0 }: { angle?: number }) {
  return (
    <svg className="arrow" viewBox="0 0 100 100" style={{ transform: `rotate(${angle - 90}deg)` }} aria-hidden>
      <path className="line" d={ARROW_INNER} />
    </svg>
  );
}

/** 옆면 겹의 아래 어긋남(앞면 높이 대비 %). 여러 겹이라 45도로 돌 때도 두께가 비지 않는다 */
const SIDE_LAYERS = [12, 9, 6, 3];

/** 판 위 빈 자리 표시 (타일과 같이 움직이도록 레이어 안에, 둘레 한 칸 더) */
function Dots() {
  const dots = [];
  for (let r = -1; r <= N; r++)
    for (let c = -1; c <= N; c++) dots.push(<circle key={`${r}.${c}`} cx={((c + 0.5) * 100) / N} cy={((r + 0.45) * 100) / N} r={0.6} />);
  return (
    <svg className="dots-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {dots}
    </svg>
  );
}

function Chevron({ dir }: { dir: Dir }) {
  return (
    <svg viewBox="0 0 20 20" style={{ transform: `rotate(${dir * 90}deg)` }} aria-hidden>
      <path d="M10 3 L17 14 L3 14 Z" />
    </svg>
  );
}

const at = (r: number, c: number): CSSProperties => ({ transform: `translate(${c * 100}%, ${r * 100}%)` });

interface Props {
  pos: Position;
  /** 지금 화면 앞의 사람이 pos.player 로 둘 수 있는가 */
  interactive: boolean;
  onMove?: (action: number) => void;
  /** 직전 수 표시 */
  showLast?: boolean;
  /** 점선 테두리로 표시할 칸(힌트) */
  marks?: number[];
  /** 빈 칸에 반투명하게 보여줄 타일 (AI 추천) */
  ghost?: { cell: number; player: 1 | -1; dir: Dir } | null;
  /** 고르는 단계가 바뀔 때 */
  onStage?: (stage: Stage) => void;
  showCoordinates?: boolean;
  /** 마지막 수에 붙일 평가 타입 */
  moveType?: ReviewType | null;
}

export type Stage = 'tile' | 'dir' | 'cell';

/** 타일을 고른 뒤 방향키 → 돌릴 방향 */
const KEY_DIR: Record<string, Dir> = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 };

export function Board({ pos, interactive, onMove, showLast = true, marks = [], ghost, onStage, showCoordinates = settings.get().coordinates, moveType }: Props) {
  const [rawSel, setSel] = useState<number | null>(null);
  const [rawDir, setDir] = useState<Dir | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // 키보드로 방향을 정하면 첫 놓을 자리로 포커스를 옮긴다 (Enter 로 바로 놓기)
  const [focusTarget, setFocusTarget] = useState(0);

  useEffect(() => {
    setSel(null);
    setDir(null);
  }, [pos]);

  useEffect(() => {
    if (focusTarget) root.current?.querySelector<HTMLButtonElement>('button.target')?.focus();
  }, [focusTarget]);

  // 판 안에 포커스가 있었는데 수 · 되돌리기 · 새 판으로 그 요소가 사라졌으면,
  // 다시 둘 차례가 올 때 고를 수 있는 첫 타일로 포커스를 돌려준다 (키보드만으로 계속 두기)
  const hadFocus = useRef(false);
  useEffect(() => {
    if (!interactive || !hadFocus.current) return;
    // 지금 어딘가(판 안의 다른 요소 포함)에 포커스가 있으면 건드리지 않는다
    const active = document.activeElement;
    if (active && active !== document.body) return;
    root.current?.querySelector<HTMLElement>('.tile.selectable')?.focus();
  }, [interactive, pos]);

  // 돌릴 칸 → 방향 → 행동 목록
  const options = useMemo(() => {
    const map = new Map<number, Map<Dir, number[]>>();
    if (!interactive) return map;
    for (const a of legal(pos.board, pos.player)) {
      if (a === PASS) continue;
      const m = decode(a)!;
      const cell = idx(m.r, m.c);
      if (!map.has(cell)) map.set(cell, new Map());
      const byDir = map.get(cell)!;
      byDir.set(m.newDir, [...(byDir.get(m.newDir) ?? []), a]);
    }
    return map;
  }, [pos, interactive]);

  // 국면이 바뀐 직후(효과로 초기화되기 전)에도 안전하도록, 지금 유효한 선택만 쓴다
  const sel = rawSel !== null && options.has(rawSel) ? rawSel : null;
  const dir = sel !== null && rawDir !== null && options.get(sel)!.has(rawDir) ? rawDir : null;

  useEffect(() => {
    onStage?.(sel === null ? 'tile' : dir === null ? 'dir' : 'cell');
  }, [sel, dir, onStage]);

  const choose = (cell: number) => {
    if (!options.has(cell)) return;
    if (sel === cell) {
      setSel(null);
      setDir(null);
      return;
    }
    setSel(cell);
    const dirs = [...options.get(cell)!.keys()];
    setDir(dirs.length === 1 ? dirs[0] : null);
  };

  const selDirs = sel !== null ? [...options.get(sel)!.keys()] : [];
  const targets = sel !== null && dir !== null ? options.get(sel)!.get(dir)! : [];
  const targetCells = new Set(targets.map((a) => idx(decode(a)!.pr, decode(a)!.pc)));

  // 선택한 타일 옆이지만 5칸 제한으로 막힌 빈 칸
  const blocked: number[] = [];
  if (sel !== null && dir !== null) {
    const r = Math.floor(sel / N), c = sel % N;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
      const i = idx(rr, cc);
      if (pos.board[i] === 0 && !targetCells.has(i) && !canPlaceAt(pos.board, rr, cc)) blocked.push(i);
    }
  }

  const lastMove = showLast ? pos.lastMove ?? pos.last : undefined;
  const rotatedCell = lastMove?.rotated ? idx(...lastMove.rotated) : -1;
  const placedCell = lastMove?.placed ? idx(...lastMove.placed) : -1;
  const markedCells = new Set(marks);

  const tiles = [];
  for (let i = 0; i < CELLS; i++) {
    const tv = pos.tiles[i];
    if (!tv) continue;
    const r = Math.floor(i / N), c = i % N;
    const v = pos.board[i];
    const selectable = options.has(i);
    const graded = !!moveType && !pos.last?.pass && i === placedCell;
    const lastLabel = i === rotatedCell ? t('board.lastRotated') : i === placedCell ? t('board.lastPlaced') : null;
    let angle = tv.angle;
    if (i === sel && dir !== null) {
      const cur = dirOf(v);
      angle += ((((dir - cur) % 4) + 6) % 4 - 2) * 90;
    }
    const order = pos.animate ? pos.flipOrder.get(tv.id) : undefined;
    const cls = [
      'tile',
      owner(v) > 0 ? 'g' : 'b',
      selectable && 'selectable',
      i === sel && 'selected',
      markedCells.has(i) && i !== sel && 'last',
      i === rotatedCell && 'last-rotated',
      i === placedCell && 'last-placed',
      pos.animate && tv.id === pos.enteredId && 'enter',
    ]
      .filter(Boolean)
      .join(' ');
    tiles.push(
      <div key={`${pos.epoch}-${tv.id}`} className={`slot tile-pos${graded ? ' graded-tile' : ''}`} style={at(r, c)}>
        <div
          className={cls}
          data-cell={i}
          role={selectable ? 'button' : undefined}
          tabIndex={selectable ? 0 : undefined}
          aria-label={`${showCoordinates ? `${formatCell(r, c)}: ` : ''}${t('aria.tile', { color: sideName(owner(v) > 0 ? 1 : -1), dir: t(`dir.${dirOf(v)}`) })}${lastLabel ? `, ${lastLabel}` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (selectable) choose(i);
            else {
              setSel(null);
              setDir(null);
            }
          }}
          onKeyDown={(e) => {
            if (selectable && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              choose(i);
              // 돌릴 방향이 하나뿐이면 바로 놓을 자리로
              if (sel !== i && options.get(i)!.size === 1) setFocusTarget((n) => n + 1);
            }
          }}
        >
          {/* 몸통 = 옆면 겹들 + 앞면. 돌릴 때는 겹마다 제자리에서 같이 돌고, 뒤집을 때는 몸통 전체가 접힌다 */}
          <div
            key={`f${tv.flips}`}
            className={order !== undefined ? 'body flip' : 'body'}
            style={{ '--a': `${angle}deg`, '--d': order !== undefined ? `${0.2 + order * 0.14}s` : '0s' } as CSSProperties}
          >
            {SIDE_LAYERS.map((o) => (
              <div key={o} className="band" style={{ '--o': `${o}%` } as CSSProperties} />
            ))}
            <div className="face">
              <Arrow />
            </div>
          </div>
          {graded && <span className="tile-grade"><MoveTypeBadge type={moveType} iconOnly /></span>}
        </div>
      </div>,
    );
  }

  // 타일 묶음이 짝수 칸이면 반 칸 어긋나므로 화면에서만 가운데로 옮긴다
  const [r0, r1, c0, c1] = bounds(pos.board);
  const dy = showCoordinates || r1 < 0 ? 0 : (N - (r1 - r0 + 1)) / 2 - r0;
  const dx = showCoordinates || c1 < 0 ? 0 : (N - (c1 - c0 + 1)) / 2 - c0;

  // 타일을 고른 상태: 방향키로 방향, Esc 로 취소 (타일 · 방향 버튼 · 놓을 자리 어디에 포커스가 있어도)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (sel === null) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      root.current?.querySelector<HTMLElement>(`.tile[data-cell="${sel}"]`)?.focus();
      setSel(null);
      setDir(null);
      return;
    }
    const d = KEY_DIR[e.key];
    if (d === undefined) return;
    e.preventDefault();
    if (!options.get(sel)!.has(d)) return;
    setDir(d);
    setFocusTarget((n) => n + 1);
  };

  return (
    <div
      ref={root}
      className={`board${showCoordinates ? ' with-coordinates' : ''}`}
      onKeyDown={onKeyDown}
      onFocus={() => {
        hadFocus.current = true;
      }}
      onBlur={(e) => {
        // 다른 곳으로 옮겼을 때만 잊는다. 포커스된 요소가 지워진 경우(relatedTarget 없음)는 기억
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) hadFocus.current = false;
      }}
      onClick={() => {
        setSel(null);
        setDir(null);
      }}
    >
      {showCoordinates && <div className="board-coordinates" aria-hidden="true">
        {'ABCDEFG'.split('').map((letter, i) => <span className="coordinate-col" key={letter} style={{ left: `${(i + 0.5) * 100 / N}%` }}>{letter}</span>)}
        {Array.from({ length: N }, (_, i) => <span className="coordinate-row" key={i} style={{ top: `${(i + 0.5) * 100 / N}%` }}>{i + 1}</span>)}
      </div>}
      <div className="layer" style={{ transform: `translate(${(dx * 100) / N}%, ${(dy * 100) / N}%)` }}>
      <Dots />
      {tiles}
      {targets.map((a) => {
        const m = decode(a)!;
        return (
          <div key={`t${a}`} className="slot" style={at(m.pr, m.pc)}>
            <button
              className={`target ${pos.player > 0 ? 'g' : 'b'}`}
              data-cell={idx(m.pr, m.pc)}
              aria-label={`${showCoordinates ? `${formatCell(m.pr, m.pc)}: ` : ''}${t('aria.place', { dir: t(`dir.${m.side}`) })}`}
              onClick={(e) => {
                e.stopPropagation();
                onMove?.(a);
              }}
            >
              <Arrow angle={m.placeDir * 90} />
            </button>
          </div>
        );
      })}
      {ghost && (
        <div className={`slot${moveType ? ' graded-tile' : ''}`} style={at(Math.floor(ghost.cell / N), ghost.cell % N)}>
          <div className={`target ghost ${ghost.player > 0 ? 'g' : 'b'}`}>
            <Arrow angle={ghost.dir * 90} />
            {moveType && <span className="tile-grade"><MoveTypeBadge type={moveType} iconOnly /></span>}
          </div>
        </div>
      )}
      {blocked.map((i) => (
        <div key={`x${i}`} className="slot" style={at(Math.floor(i / N), i % N)}>
          <div className="blocked" aria-label={t('aria.blocked')}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
            </svg>
          </div>
        </div>
      ))}
      {sel !== null &&
        selDirs.map((d) => {
          const r = Math.floor(sel / N) + DIRS[d][0] * 0.54;
          const c = (sel % N) + DIRS[d][1] * 0.54;
          return (
            <button
              key={`c${d}`}
              className={`chev-btn ${dir === d ? 'on' : ''}`}
              data-dir={d}
              style={{ ...at(r, c), left: 0, top: 0 }}
              aria-label={t('aria.rotate', { dir: t(`dirTo.${d}`) })}
              aria-pressed={dir === d}
              onClick={(e) => {
                e.stopPropagation();
                setDir(d);
              }}
            >
              <span>
                <Chevron dir={d} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
