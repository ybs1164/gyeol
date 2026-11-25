import type { GameAnalysis } from '@gyeol/ai';
import { movesPlayed, type Player } from '@gyeol/core';
import type { ReviewType } from '../lib/move-types';
import { t } from '../i18n';
import { forcedWinLabel, type WinDistancePoint } from '../lib/win-label';
import { sideName } from '../lib/skins';

/** actions 를 주면 축과 읽기 문구의 수 번호에서 패스를 뺀다. 그래프의 점은 그대로 국면마다 하나다. */
export function AnalysisGraph({ analysis, actions, at, perspective, jump, label = t('review.title') }: { analysis: { positions: ((NonNullable<GameAnalysis['positions'][number]> & WinDistancePoint) | null)[]; marks?: readonly ({ type: ReviewType | null; player: Player } | null)[] }; actions?: readonly number[]; at: number; perspective: Player; jump: (at: number) => void; label?: string }) {
  const n = analysis.positions.length - 1;
  const shown = (i: number) => actions ? movesPlayed(actions, i) : i;
  const W = 360, H = 160, L = 30, R = 12, T = 12, B = 25;
  const x = (i: number) => L + i / Math.max(1, n) * (W - L - R);
  const y = (green: number) => T + (perspective === 1 ? 1 - green : green) * (H - T - B);
  const segments: string[] = [];
  let segment: string[] = [];
  analysis.positions.forEach((p, i) => {
    if (p) segment.push(`${x(i)},${y(p.green)}`);
    else if (segment.length) { segments.push(segment.join(' ')); segment = []; }
  });
  if (segment.length) segments.push(segment.join(' '));
  const current = analysis.positions[at];
  const forcedLabel = forcedWinLabel(current, perspective);
  const select = (clientX: number, element: SVGSVGElement) => {
    const bounds = element.getBoundingClientRect();
    jump(Math.max(0, Math.min(n, Math.round(((clientX - bounds.left) / bounds.width * W - L) / (W - L - R) * n))));
  };
  return (
    <svg className={`analysis-graph ${perspective === 1 ? 'g' : 'b'}`} viewBox={`0 0 ${W} ${H}`}
      role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={n} aria-valuenow={at}
      aria-valuetext={forcedLabel ? `${t('rp.move', { i: shown(at), n: shown(n) })} · ${forcedLabel}` : t('rp.move', { i: shown(at), n: shown(n) })}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); select(e.clientX, e.currentTarget); }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) select(e.clientX, e.currentTarget); }}
      onKeyDown={e => {
        const next = e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowRight' ? at + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n : null;
        if (next !== null) { e.preventDefault(); jump(Math.max(0, Math.min(n, next))); }
      }}>
      {[0, 50, 100].map(v => <line key={v} x1={L} y1={T + (1 - v / 100) * (H - T - B)} x2={W - R} y2={T + (1 - v / 100) * (H - T - B)} className={v === 50 ? 'mid' : 'grid'} />)}
      {[...new Set([0, Math.round(n / 2), n])].map(i => <text key={i} x={x(i)} y={H - 6} textAnchor="middle">{shown(i)}</text>)}
      {segments.map((points, i) => <polyline key={i} points={points} className="curve" />)}
      {analysis.marks?.map((mark, i) => {
        const p = analysis.positions[i + 1];
        if (!mark?.type || !p) return null;
        const { type, player } = mark;
        // 보는 색의 수는 선 위에, 상대의 수는 선 아래에 흐리게 그려 누구의 수인지 구분한다.
        const own = player === perspective, side = own ? 'own' : 'opponent';
        const cx = x(i + 1), cy = own ? Math.max(T + 9, y(p.green) - 7) : Math.min(H - B - 2, y(p.green) + 16);
        const title = <title>{`${sideName(player)} · ${t(`type.${type}`)}`}</title>;
        // 공격은 !, 내준 수는 ?, 최선 수는 ★, 방어는 작은 방패로 표시한다.
        return type === 'defense'
          ? <path key={i} className={`event grade-event type-defense ${side}`} data-type="defense" data-side={side} transform={`translate(${cx - 4} ${cy - 9})`} d="M4 0 8 1.4v3.2c0 2.4-1.7 4.2-4 5.1-2.3-.9-4-2.7-4-5.1V1.4Z">{title}</path>
          : <text key={i} x={cx} y={cy} className={`event grade-event type-${type} ${side}`} data-type={type} data-side={side} textAnchor="middle">{type === 'attack' ? '!' : type === 'best' ? '★' : '?'}{title}</text>;
      })}
      <line x1={x(at)} y1={T} x2={x(at)} y2={H - B} className="cursor" />
      {current && <circle cx={x(at)} cy={y(current.green)} r={3.5} className="point">{forcedLabel && <title>{forcedLabel}</title>}</circle>}
      {current && forcedLabel && <text className="win-proof" x={Math.max(L + 50, Math.min(W - R - 50, x(at)))} y={y(current.green) > H / 2 ? y(current.green) - 9 : y(current.green) + 17} textAnchor="middle">{forcedLabel}</text>}
    </svg>
  );
}
