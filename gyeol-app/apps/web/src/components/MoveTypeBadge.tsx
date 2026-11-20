import type { ReactNode } from 'react';
import { t } from '../i18n';
import type { ReviewType } from '../lib/move-types';

const dot = (x: number, y = 18) => <circle cx={x} cy={y} r="1.2" fill="currentColor" stroke="none" />;
/** 24px 캔버스. 공격은 느낌표, 내준 수는 물음표, 방어는 방패, 최선 수는 별. */
export const TYPE_ART: Record<ReviewType, ReactNode> = {
  attack: <><path d="M12 5.5v8" />{dot(12)}</>,
  best: <path d="m12 3.8 2.5 5.2 5.6.7-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.7Z" />,
  defense: <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6Z" />,
  gift: <><path d="M8.5 8.5a3.5 3.5 0 0 1 7 0c0 2.5-3.5 2.5-3.5 5" />{dot(12)}</>,
};

/** 수 평가 타입 배지. 해당하는 타입이 없는 수에는 아무것도 그리지 않는다. */
export function MoveTypeBadge({ type, iconOnly = false }: { type: ReviewType | null | undefined; iconOnly?: boolean }) {
  if (!type) return null;
  const label = t(`type.${type}`);
  return <span className={`move-grade type-${type}${iconOnly ? ' icon-only' : ''}`} data-type={type} title={label} aria-label={label} role={iconOnly ? 'img' : undefined}>
    <span className="grade-symbol" aria-hidden="true">
      <svg className="grade-icon" data-type-icon={type} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{TYPE_ART[type]}</svg>
    </span>
    {!iconOnly && <span className="grade-name">{label}</span>}
  </span>;
}
