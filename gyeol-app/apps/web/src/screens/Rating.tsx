import { useEffect, useState } from 'react';
import { connect, send, useOnline } from '../lib/online';
import { TIERS, tierOf } from '../lib/tier';
import { TierBadge, TierProgress, TopBar } from '../components/ui';
import { TwoColumns } from '../components/AppShell';
import { getLang, t } from '../i18n';
import { ratingWindow, weekDelta } from '../lib/rating-history';
import type { Go } from '../App';

type Period = 7 | 30 | 0;

/** 레이팅: 지금 · 다음 티어 · 그래프 · 최고/최저 · 티어 표 */
export function Rating({ go }: { go: Go }) {
  const s = useOnline();
  const [period, setPeriod] = useState<Period>(30);
  const me = s.me;

  useEffect(() => {
    connect();
    send({ t: 'history' });
  }, []);

  const rating = me?.rating ?? 1500;
  const ranked = me?.rated ?? me?.ranked ?? 0;
  const tier = tierOf(rating, ranked);
  const all = s.history ?? [];
  const now = Date.now() + s.skew;
  const pts = ratingWindow(all, period, now);
  const values = pts.map((p) => p.rating);
  const lo = values.reduce((min, v) => Math.min(min, v), 1500) - 20;
  const hi = values.reduce((max, v) => Math.max(max, v), 1500) + 20;
  const y = (v: number) => 40 - ((v - lo) / (hi - lo)) * 40;
  const fmt = new Intl.DateTimeFormat(getLang(), { month: 'short', day: 'numeric' });
  const week = weekDelta(all, rating, s.ratingSummary?.complete, now);
  const firstAt = pts[0]?.at ?? now;
  const span = Math.max(1, (pts.at(-1)?.at ?? now) - firstAt);

  return (
    <div className="screen rating-page">
      <TopBar onBack={() => go('me')} title={t('rating.title')} />
      <TwoColumns
        left={
          <>
      <div className="rating-hero">
        <TierBadge tier={tier} size={56} />
        <div>
          <b>{me ? rating : '–'}</b>
          <small>{t(`tier.${tier}`)}</small>
        </div>
      </div>
      <TierProgress rating={rating} ranked={ranked} />

      <div className="seg">
        {([7, 30, 0] as Period[]).map((p) => (
          <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
            {p ? t('rating.days', { n: p }) : t(s.ratingSummary?.complete ? 'me.all' : 'rating.savedHistory')}
          </button>
        ))}
      </div>

      <div className="card chart">
        {pts.length < 2 ? (
          <div className="empty">{t('rank.empty')}</div>
        ) : (
          <>
            <svg viewBox="0 0 100 40" preserveAspectRatio="none">
              <line className="gl" x1="0" y1={y(1500)} x2="100" y2={y(1500)} />
              <polyline className="ln" points={pts.map((p) => `${((p.at - firstAt) / span) * 100},${y(p.rating)}`).join(' ')} />
            </svg>
            <div className="cap">
              <span>{fmt.format(pts[0].at)}</span>
              <span>{fmt.format(pts[pts.length - 1].at)}</span>
            </div>
          </>
        )}
      </div>

      <div className="stats three">
        <div>
          <b>{s.ratingSummary?.peak ?? (all.length ? all.reduce((max, p) => Math.max(max, p.rating), -Infinity) : '–')}</b>
          <span>{t(s.ratingSummary?.complete ? 'rating.max' : 'rating.recordedMax')}</span>
        </div>
        <div>
          <b>{s.ratingSummary?.lowest ?? (all.length ? all.reduce((min, p) => Math.min(min, p.rating), Infinity) : '–')}</b>
          <span>{t(s.ratingSummary?.complete ? 'rating.min' : 'rating.recordedMin')}</span>
        </div>
        <div>
          <b className={week !== null && week > 0 ? 'plus' : week !== null && week < 0 ? 'minus' : ''} style={{ fontSize: 18 }}>
            {week === null ? '–' : week > 0 ? `+${week}` : week < 0 ? `−${-week}` : '0'}
          </b>
          <span>{t('rating.week')}</span>
        </div>
      </div>
      <p className="muted small">{t('rating.rules')}</p>
      <p className="muted small">{t('rating.placementRule')}</p>
      <p className="muted small">{t('rating.rankEligibility')}</p>
          </>
        }
        right={
      <section>
        <p className="label">{t('rating.tiers')}</p>
        <div className="group ladder">
          {TIERS.map((x, i) => (
            <div key={x.id} className={`item ${tier === x.id ? 'cur' : ''}`}>
              <TierBadge tier={x.id} size={22} />
              <span className="grow strong">{t(`tier.${x.id}`)}</span>
              {tier === x.id && <span className="pill go">{t('rating.current')}</span>}
              <span className="muted small">{Number.isFinite(x.min) ? `${x.min}~` : `~${TIERS[i - 1].min - 1}`}</span>
            </div>
          ))}
          <div className={`item ${tier === 'place' ? 'cur' : ''}`}>
            <TierBadge tier="place" size={22} />
            <span className="grow strong">{t('tier.place')}</span>
            {tier === 'place' && <span className="pill go">{t('rating.current')}</span>}
            <span className="muted small">{t('rating.placement', { n: 5 })}</span>
          </div>
        </div>
      </section>
        }
      />
    </div>
  );
}
