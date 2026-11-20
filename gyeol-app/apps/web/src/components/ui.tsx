import { useEffect, type CSSProperties, type ReactNode } from 'react';
import type { Player } from '@gyeol/core';
import { Icon } from './Icon';
import { ARROW_INNER, HOLE } from './tileArt';
import { Arrow } from './Board';
import { TIER_MARK, nextTier, tierOf, type TierId } from '../lib/tier';
import { t } from '../i18n';

/** 위쪽 막대: 뒤로 + 가운데 제목 */
export function TopBar({ onBack, title, right }: { onBack?: () => void; title?: ReactNode; right?: ReactNode }) {
  return (
    <div className="topbar">
      {onBack ? (
        <button className="icon-btn" onClick={onBack} aria-label={t('nav.back')}>
          <Icon name="back" />
        </button>
      ) : (
        <span />
      )}
      {title ? <h2>{title}</h2> : <span />}
      {right ?? <span />}
    </div>
  );
}

/** 티어 배지: 단색 미니 타일 + 머리글자 */
export function TierBadge({ tier, size = 36 }: { tier: TierId; size?: number }) {
  return (
    <span className={`mini tier-${tier}`} style={{ '--s': `${size}px` } as CSSProperties} aria-label={t(`tier.${tier}`)}>
      <b>{TIER_MARK[tier]}</b>
    </span>
  );
}

/** 퍼즐 단계 배지: 단계 색 미니 타일 + 숫자 */
export function StageBadge({ n, size = 36 }: { n: number; size?: number }) {
  return (
    <span className={`mini stage-${n}`} style={{ '--s': `${size}px` } as CSSProperties} aria-label={t('rated.stage', { n })}>
      <b>{n}</b>
    </span>
  );
}

/** 목록 아이콘: 갈색 미니 타일 + 선 아이콘 */
export function TileIcon({ name }: { name: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <span className="mini">
      <Icon name={name} />
    </span>
  );
}

/** 선공 · 후공 미니 타일: 갈색 면 + 그 사람의 화살표 선 색 (위를 가리킴) */
export function SideTile({ color, size = 32 }: { color: Player; size?: number }) {
  return (
    <span className={`mini side-${color === 1 ? 'g' : 'b'}`} style={{ '--s': `${size}px` } as CSSProperties}>
      <Arrow />
    </span>
  );
}

/** 다음 티어까지 막대 */
export function TierProgress({ rating, ranked, compact = false }: { rating: number; ranked: number; compact?: boolean }) {
  const next = nextTier(rating, ranked);
  if (!next) return null;
  return (
    <div className="next">
      {!compact && (
        <div className="cap">
          <span>{t('tier.to', { tier: t(`tier.${next.id}`), min: next.min })}</span>
          <b>{next.left}</b>
        </div>
      )}
      <div className="track">
        <i style={{ width: `${Math.round(next.progress * 100)}%` }} />
      </div>
    </div>
  );
}

/** 대국 화면의 사람 한 줄: 티어 · 이름 · 티어와 레이팅 · (시계) */
export function PlayerRow({
  name, color, rating, ranked, bot, right,
}: { name: ReactNode; color: Player; rating?: number; ranked?: number; bot?: boolean; right?: ReactNode }) {
  const tier = rating !== undefined ? tierOf(rating, ranked ?? 0, bot) : null;
  return (
    <div className="player">
      {tier ? <TierBadge tier={tier} size={32} /> : <SideTile color={color} size={32} />}
      <div className="who">
        <b>{name}</b>
        <small>
          <span className={`dot ${color === 1 ? 'g' : 'b'}`} />
          {tier ? `${t(`tier.${tier}`)} · ${rating}` : null}
        </small>
      </div>
      {right}
    </div>
  );
}

/** 가운데 팝업. 바깥을 누르면 닫힌다 */
export function Popup({ children, onClose, className = '' }: { children: ReactNode; onClose?: () => void; className?: string }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className={`popup${className ? ` ${className}` : ''}`} role="dialog" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** 매칭 중: 타일이 90도씩 돈다. 옆면 겹을 같이 돌려 두께를 유지 */
export function SpinTile({ size = 130 }: { size?: number }) {
  const layer = (dy: number, inner: ReactNode) => (
    <g key={dy} transform={`translate(50 ${50 + dy})`}>
      <g className="spin-rot">{inner}</g>
    </g>
  );
  const side = <rect className="spin-side" x="-50" y="-50" width="100" height="100" rx="10" />;
  const top = (
    <g transform="translate(-50 -50)">
      <rect className="spin-face" x="0" y="0" width="100" height="100" rx="10" />
      <path className="spin-line" d={ARROW_INNER} />
      <circle className="spin-hole" cx={HOLE.cx} cy={HOLE.cy} r={HOLE.r} />
    </g>
  );
  return (
    <svg className="spin3d" viewBox="-22 -22 144 158" style={{ width: size }} aria-hidden>
      {[12, 9, 6, 3].map((d) => layer(d, side))}
      {layer(0, top)}
    </svg>
  );
}

/** 남은 시간 표시: 1시간 이상이면 "18시간", 아니면 m:ss */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return t('time.hours', { n: Math.floor(s / 3600) });
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
