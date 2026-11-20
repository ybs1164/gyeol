import { useEffect, useState } from 'react';
import { TIME_MODES, type TimeMode } from '@gyeol/core';
import { connect, send, useOnline } from '../lib/online';
import { records, settings, type GameRecord } from '../lib/storage';
import { tierOf } from '../lib/tier';
import { sideName } from '../lib/skins';
import { Icon } from '../components/Icon';
import { TierBadge } from '../components/ui';
import { AppShell, TwoColumns } from '../components/AppShell';
import { getLang, t } from '../i18n';
import { weekDelta } from '../lib/rating-history';
import type { Go, Route } from '../App';

/** 기록 한 줄의 결과: 승 · 패 · 무 (둘이서는 이긴 색) */
function outcome(r: GameRecord): { mark: string; cls: 'w' | 'l' | 'd' } {
  if (r.winner === 0) return { mark: t('rec.draw'), cls: 'd' };
  if (r.me === null) return { mark: sideName(r.winner).slice(0, 1), cls: 'd' };
  return r.winner === r.me ? { mark: t('rec.win'), cls: 'w' } : { mark: t('rec.lose'), cls: 'l' };
}

/** 방금 · n분 전 · n시간 전 · 어제 · 날짜 */
function when(date: number): string {
  const diff = Date.now() - date;
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' });
  if (diff < 60_000) return t('time.now');
  if (diff < 3_600_000) return rtf.format(-Math.floor(diff / 60_000), 'minute');
  if (diff < 86_400_000) return rtf.format(-Math.floor(diff / 3_600_000), 'hour');
  if (diff < 2 * 86_400_000) return rtf.format(-1, 'day');
  return new Intl.DateTimeFormat(getLang(), { month: 'short', day: 'numeric' }).format(date);
}

export function MyInfo({ go, route }: { go: Go; route: Route }) {
  const s = useOnline();
  const [filter, setFilter] = useState<TimeMode | 'all'>('all');
  const me = s.me;

  useEffect(() => {
    connect();
    send({ t: 'history' });
  }, []);

  const tier = me ? tierOf(me.rating, me.rated ?? me.ranked) : 'place';
  const total = me ? me.wins + me.losses : 0;
  const draws = me ? Math.max(0, me.ranked - me.wins - me.losses) : 0;
  const list = records.all().filter((r) => filter === 'all' || r.timeMode === filter);
  const week = me && s.history ? weekDelta(s.history, me.rating, s.ratingSummary?.complete, Date.now() + s.skew) : null;

  return (
    <AppShell route={route} go={go} width="wide">
      <h2 className="page-title">{t('tab.me')}</h2>
      <TwoColumns
        left={
          <>
      <div className="me-head">
        <TierBadge tier={tier} size={56} />
        <div>
          <b>{settings.get().nickname}</b>
          <small>{t(`tier.${tier}`)}</small>
        </div>
      </div>

      <div className="stats">
        <div>
          <b>{me?.ranked ?? 0}</b>
          <span>{t('me.games')}</span>
        </div>
        <div>
          <b>{me?.wins ?? 0}</b>
          <span>{t('rec.win')}</span>
        </div>
        <div>
          <b>{me?.losses ?? 0}</b>
          <span>{t('rec.lose')}</span>
        </div>
        <div>
          <b>{total + draws > 0 ? `${Math.round(((me?.wins ?? 0) / (total + draws)) * 100)}%` : '–'}</b>
          <span>{t('me.rate')}</span>
        </div>
      </div>

      <button className="card rating-link" onClick={() => go('rating')}>
        <span className="k">{t('rating.title')}</span>
        <span className="v">
          <b>{me?.rating ?? '–'}</b>
          {week !== null && week !== 0 && <span className={week > 0 ? 'plus' : 'minus'}>{week > 0 ? `+${week}` : `−${-week}`}</span>}
        </span>
        <Icon name="chevron" className="chev" />
      </button>
          </>
        }
        right={
          <>
      <div className="seg">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          {t('me.all')}
        </button>
        {TIME_MODES.map((m) => (
          <button key={m.id} aria-pressed={filter === m.id} onClick={() => setFilter(m.id)}>
            <Icon name={m.id} />
            {t(`mode.${m.id}`)}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="status">{t('rec.empty')}</p>
      ) : (
        <div className="group log">
          {list.map((r) => {
            const o = outcome(r);
            const score = r.score ? `${r.score.me} : ${r.score.opp}` : null;
            const reason = r.endReason === 'timeout' ? t('og.byTimeout') : r.endReason === 'resign' ? t('og.byResign') : score;
            const d = r.ratingChange;
            return (
              <button key={r.id} className="item" onClick={() => go('replay', r.id)}>
                <span className={`res ${o.cls}`}>{o.mark}</span>
                <span className="txt">
                  <b>
                    {r.mode === 'online' && r.oppRating !== undefined && <TierBadge tier={tierOf(r.oppRating, r.oppRanked ?? 0, r.oppBot)} size={18} />}
                    {r.mode === 'online' ? r.opponent ?? '?' : r.mode === 'ai' ? t('rec.ai', { level: t(`level.${r.level ?? 'easy'}`) }) : t('rec.local')}
                  </b>
                  <small>
                    {r.timeMode && <Icon name={r.timeMode} />}
                    {[r.timeMode ? t(`mode.${r.timeMode}`) : r.mode === 'local' ? t('rec.local') : t('lobby.solo'), reason, when(r.date)]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
                {d !== undefined && <span className={d > 0 ? 'plus' : d < 0 ? 'minus' : 'even'}>{d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}</span>}
              </button>
            );
          })}
        </div>
      )}
          </>
        }
      />
    </AppShell>
  );
}
