import { useEffect, useState } from 'react';
import { dateKey, replay, stageOf, type OnlineGame } from '@gyeol/core';
import { puzzleLog, puzzleRating, settings } from '../lib/storage';
import { streak } from '../lib/puzzle-stats';
import { connect, send, useOnline } from '../lib/online';
import { tierOf } from '../lib/tier';
import { Icon } from '../components/Icon';
import { MiniBoard } from '../components/MiniBoard';
import { NicknamePopup } from '../components/NicknamePopup';
import { StageBadge, TierBadge, TileIcon, formatClock } from '../components/ui';
import { AppShell, TwoColumns } from '../components/AppShell';
import { t } from '../i18n';
import type { Go, Route } from '../App';

const base = import.meta.env.BASE_URL;

/** 내 차례인 온라인 대국의 남은 시간 */
export function myTimeLeft(g: OnlineGame, skew: number): number | null {
  const now = Date.now() + skew;
  if (g.clock) {
    const { player } = replay(g.moves);
    return g.clock[player === 1 ? 'green' : 'brown'] - (now - g.turnStartedAt);
  }
  return g.turnLimitMs ? g.turnLimitMs - (now - g.turnStartedAt) : null;
}

export function Lobby({ go, route, onChange }: { go: Go; route: Route; onChange: () => void }) {
  const online = useOnline();
  const [editing, setEditing] = useState(false);
  const [, tick] = useState(0);
  const today = puzzleLog.get(dateKey());
  const days = streak();
  const pz = puzzleRating.get();
  const pzStage = stageOf(pz.rating).n;
  const me = online.me;

  useEffect(() => {
    connect();
    send({ t: 'games' });
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // 내 차례인 대국만
  const mine = me
    ? online.list
        .map((id) => online.games[id])
        .filter((g): g is OnlineGame => {
          if (!g || g.status !== 'active') return false;
          const { player } = replay(g.moves);
          return (player === 1 ? g.green : g.brown)?.id === me.id;
        })
    : [];

  const tier = me ? tierOf(me.rating, me.rated ?? me.ranked) : 'place';
  const total = me ? me.wins + me.losses : 0;

  return (
    <AppShell route={route} go={go} play width="wide">
      <div className="lobby-head">
        <img className="brand-mark" src={`${base}tiles/front.svg`} alt="결" />
        <h2>{t('tab.lobby')}</h2>
      </div>

      <TwoColumns
        left={
          <>
      <button className="card profile" onClick={() => setEditing(true)}>
        <TierBadge tier={tier} size={46} />
        <span className="who">
          <b>
            {settings.get().nickname}
            <Icon name="pencil" />
          </b>
          <small>{me ? `${t(`tier.${tier}`)} · ${me.rating}` : t('lobby.offline')}</small>
        </span>
        {me && (
          <span className="wl">
            <strong>{t('online.record', { w: me.wins, l: me.losses })}</strong>
            <br />
            {total > 0 && t('me.rateN', { n: Math.round((me.wins / total) * 100) })}
          </span>
        )}
      </button>

      {mine.length > 0 && (
        <section>
          <p className="label">{t('lobby.online')}</p>
          <div className="group">
            {mine.map((g) => {
              const opp = g.green?.id === me!.id ? g.brown : g.green;
              const left = myTimeLeft(g, online.skew);
              return (
                <button key={g.id} className="item daily-row" onClick={() => go('g', g.id)}>
                  <MiniBoard moves={g.moves} />
                  <span className="txt">
                    <b>{t('online.vs', { name: opp?.name ?? '' })}</b>
                    <small>
                      <Icon name={g.mode} />
                      {t(`mode.${g.mode}`)}
                      {left !== null && ` · ${t('time.left', { t: formatClock(left) })}`}
                    </small>
                  </span>
                  <Icon name="chevron" className="chev" />
                </button>
              );
            })}
          </div>
        </section>
      )}
          </>
        }
        right={
      <section>
        <p className="label">{t('lobby.solo')}</p>
        <div className="group">
          <button className="item" onClick={() => go('ai')}>
            <TileIcon name="ai" />
            <span className="txt">
              <b>{t('home.ai')}</b>
              <small>{t('home.ai.sub')}</small>
            </span>
            <Icon name="chevron" className="chev" />
          </button>
          <button className="item" onClick={() => go('puzzle')}>
            <TileIcon name="puzzle" />
            <span className="txt">
              <b>{t('home.puzzle')}</b>
            </span>
            <span className={`pill ${today.solved ? '' : 'go'}`}>
              {today.solved ? (days > 1 ? t('badge.streak', { n: days }) : t('badge.done')) : t('badge.newPuzzle')}
            </span>
            <Icon name="chevron" className="chev" />
          </button>
          <button className="item" onClick={() => go('puzzles')}>
            <TileIcon name="stairs" />
            <span className="txt">
              <b>{t('home.rated')}</b>
              {pz.played > 0 && <small>{t('home.rated.sub2', { n: pzStage, r: pz.rating })}</small>}
            </span>
            {pz.played > 0 && <StageBadge n={pzStage} size={24} />}
            <Icon name="chevron" className="chev" />
          </button>
          <button className="item" onClick={() => go('local')}>
            <TileIcon name="local" />
            <span className="txt">
              <b>{t('home.local')}</b>
              <small>{t('home.local.sub')}</small>
            </span>
            <Icon name="chevron" className="chev" />
          </button>
          <button className="item" onClick={() => go('learn')}>
            <TileIcon name="learn" />
            <span className="txt">
              <b>{t('home.learn')}</b>
              <small>{t('lobby.learnSub')}</small>
            </span>
            <Icon name="chevron" className="chev" />
          </button>
        </div>
      </section>
        }
      />

      {editing && (
        <NicknamePopup
          onClose={(changed) => {
            setEditing(false);
            if (changed) onChange();
          }}
        />
      )}
    </AppShell>
  );
}
