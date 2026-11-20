import type { ReactNode } from 'react';
import { Popup, TierBadge, TierProgress } from './ui';
import { tierOf } from '../lib/tier';
import { t } from '../i18n';

const base = import.meta.env.BASE_URL;

interface Props {
  title: string;
  /** 시간 초과 · 기권 같은 덧붙임 */
  sub?: string | null;
  green: number;
  brown: number;
  /** 랭크전이면 바뀐 레이팅 */
  rating?: { after: number; delta: number; ranked: number } | null;
  primary: { label: string; onClick: () => void };
  onReview?: () => void;
  onLobby: () => void;
  onClose: () => void;
  extra?: ReactNode;
}

/** 대국 결과 팝업: 점수 · 레이팅 변동 · 다음 티어 */
export function ResultPopup({ title, sub, green, brown, rating, primary, onReview, onLobby, onClose, extra }: Props) {
  const d = rating?.delta ?? 0;
  return (
    <Popup onClose={onClose}>
      <div className="result-pop options" style={{ gap: 12 }}>
        <img className="brand-mark" src={`${base}tiles/hero.svg`} alt="" />
        <h3>{title}</h3>
        {sub && <div className="sub">{sub}</div>}
        <div className="score-line">
          <span className="dot g" />
          <b>{green}</b>
          <span className="muted">:</span>
          <b>{brown}</b>
          <span className="dot b" />
        </div>
        {rating && (
          <>
            <div className="delta">
              <TierBadge tier={tierOf(rating.after, rating.ranked)} size={40} />
              <div className="nums">
                <b>{rating.after}</b> <span className={d > 0 ? 'plus' : d < 0 ? 'minus' : 'even'}>{d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}</span>
                <small>{t(`tier.${tierOf(rating.after, rating.ranked)}`)}</small>
              </div>
            </div>
            <TierProgress rating={rating.after} ranked={rating.ranked} compact />
          </>
        )}
        {extra}
        <div className="row2">
          <button className="btn primary" onClick={primary.onClick}>
            {primary.label}
          </button>
          {onReview && (
            <button className="btn" onClick={onReview}>
              {t('game.review')}
            </button>
          )}
        </div>
        <button className="textlink" onClick={onLobby}>
          {t('result.lobby')}
        </button>
      </div>
    </Popup>
  );
}
