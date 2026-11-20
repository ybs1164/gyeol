import { useEffect, useMemo, useRef, useState } from 'react';
import { PASS, counts, initial, legal, replay, type OnlineGame as Game, type Player } from '@gyeol/core';
import { Board } from '../components/Board';
import { MovePreview } from '../components/MovePreview';
import { ResultPopup } from '../components/ResultPopup';
import { GameLayout, MoveList, movesFromActions } from '../components/GameLayout';
import { PlayerRow, TopBar, formatClock } from '../components/ui';
import { advance, startPosition, type Position } from '../game/track';
import { connect, queue, send, useOnline, webUrl } from '../lib/online';
import { records } from '../lib/storage';
import { sideName } from '../lib/skins';
import { sound } from '../lib/sound';
import { shareText } from '../lib/platform';
import { t } from '../i18n';
import type { Go } from '../App';

/** 서버의 수 목록과 화면 국면을 맞춘다: 한 수 늘었으면 애니메이션, 아니면 처음부터 다시 */
function sync(pos: Position | null, moves: number[]): Position {
  const done = pos?.moves ?? -1;
  if (pos && done === moves.length) return pos;
  if (pos && done === moves.length - 1) return withCount(advance(pos, moves[moves.length - 1]), moves.length);
  if (pos && done === moves.length - 2 && moves[moves.length - 1] === PASS) {
    const placed = advance(pos, moves[done]);
    const passed = advance(placed, PASS);
    return withCount({ ...passed, last: placed.last, flipOrder: placed.flipOrder, enteredId: placed.enteredId }, moves.length);
  }
  let p = startPosition(initial(), 1);
  for (const a of moves) p = advance(p, a);
  return withCount({ ...p, animate: false }, moves.length);
}
const withCount = (p: Position, n: number) => Object.assign(p, { moves: n });

/** 각자 남은 시간(ms). 1일 모드는 둘 차례인 쪽만 */
function clocks(g: Game, now: number): { green: number | null; brown: number | null } {
  const { player } = replay(g.moves);
  const running = g.status === 'active';
  const used = running ? now - g.turnStartedAt : 0;
  if (g.clock)
    return {
      green: g.clock.green - (player === 1 ? used : 0),
      brown: g.clock.brown - (player === -1 ? used : 0),
    };
  if (g.turnLimitMs && running) {
    const left = g.turnLimitMs - used;
    return { green: player === 1 ? left : null, brown: player === -1 ? left : null };
  }
  return { green: null, brown: null };
}

export function OnlineGame({ id, go }: { id: string; go: Go }) {
  const s = useOnline();
  const g: Game | undefined = s.games[id];
  const [pos, setPos] = useState<Position | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [showResult, setShowResult] = useState(true);
  const saved = useRef(false);
  const lastError = useRef(s.lastError?.at ?? 0);

  useEffect(() => {
    connect();
    send({ t: 'open', id });
  }, [id]);

  // 서버 상태 → 화면 국면
  useEffect(() => {
    if (!g) return;
    setPos((p) => {
      const next = sync(p, g.moves);
      if (next !== p && next.animate && p && !next.last?.pass) {
        sound.place();
        sound.flip(next.last?.flipped?.length ?? 0);
      }
      return next;
    });
  }, [g?.moves.length, g]);

  // 거부된 수 → 서버 기준으로 되돌림
  useEffect(() => {
    if (!s.lastError || s.lastError.at === lastError.current) return;
    lastError.current = s.lastError.at;
    setToast(t(`err.${s.lastError.code}`));
    if (g) setPos(sync(null, g.moves));
  }, [s.lastError, g]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  // 시계
  useEffect(() => {
    if (g?.status !== 'active' || (!g.clock && !g.turnLimitMs)) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [g?.status, g?.clock, g?.turnLimitMs]);

  const me = s.me;
  const myColor: Player | 0 = g && me ? (g.green?.id === me.id ? 1 : g.brown?.id === me.id ? -1 : 0) : 0;

  // 끝난 대국 기록 저장
  useEffect(() => {
    if (!g || g.status !== 'finished' || saved.current || !myColor) return;
    saved.current = true;
    const opp = myColor === 1 ? g.brown : g.green;
    const c = counts(replay(g.moves).board);
    records.add({
      id: `o-${g.id}`,
      ruleVersion: 'facing-25-v1',
      mode: 'online',
      date: g.updatedAt,
      moves: g.moves,
      winner: g.winner ?? 0,
      me: myColor,
      ranked: g.ranked,
      opponent: opp?.name,
      oppRating: opp?.rating,
      oppRanked: opp?.rated ?? opp?.ranked,
      oppBot: opp?.bot,
      timeMode: g.mode,
      score: myColor === 1 ? { me: c.green, opp: c.brown } : { me: c.brown, opp: c.green },
      endReason: g.endReason ?? 'normal',
      ratingChange: g.ratingChange ? (myColor === 1 ? g.ratingChange.green : g.ratingChange.brown) : undefined,
    });
    sound.end();
  }, [g, myColor]);

  if (!g || !pos || !me)
    return (
      <div className="screen">
        <TopBar onBack={() => go('')} />
        <p className="status">{s.lastError?.code === 'not_found' ? t('err.not_found') : <span className="spin" />}</p>
      </div>
    );

  const { player } = replay(g.moves);
  const myTurn = g.status === 'active' && myColor === player && pos.moves === g.moves.length;
  const mustPass = myTurn && legal(pos.board, pos.player)[0] === PASS;

  const play = (a: number) => {
    const ply = g.moves.length;
    send({ t: 'move', id: g.id, ply, action: a });
    // 낙관적 반영
    const next = withCount(advance(pos, a), ply + 1);
    if (a !== PASS) {
      sound.place();
      sound.flip(next.last?.flipped?.length ?? 0);
    }
    setPos(next);
  };

  const invite = async () => {
    const url = `${webUrl()}/#/join/${g.code}`;
    const text = t('og.invite', { code: g.code ?? '', url });
    if ((await shareText(text)) === 'copied') setToast(t('og.copied'));
  };

  // ---------- 친구 대기실 ----------
  if (g.status === 'waiting')
    return (
      <div className="screen">
        <TopBar onBack={() => go('pvp')} title={t('play.invite')} />
        <div className="spacer" />
        <div className="panel center-text">
          <h3>{t('og.waiting')}</h3>
          <div className="code">{g.code}</div>
          <button className="btn primary" onClick={invite}>
            {t('og.shareLink')}
          </button>
          <button
            className="btn"
            onClick={() => {
              send({ t: 'resign', id: g.id });
              go('pvp', '', true);
            }}
          >
            {t('og.closeRoom')}
          </button>
        </div>
        <div className="spacer" />
        {toast && <div className="toast">{toast}</div>}
      </div>
    );

  // ---------- 대국 ----------
  const left = clocks(g, now + s.skew);
  const low = (ms: number | null) => ms !== null && !!g.clock && ms <= 20_000;
  const bottom: Player = myColor === -1 ? -1 : 1; // 나는 아래
  const row = (p: Player) => {
    const pl = p === 1 ? g.green : g.brown;
    const ms = p === 1 ? left.green : left.brown;
    return (
      <PlayerRow
        color={p}
        name={
          pl ? (
            <>
              {pl.name}
              {pl.bot && <span className="pill ai-tag">AI</span>}
            </>
          ) : (
            t('online.nobody')
          )
        }
        rating={pl?.rating}
        ranked={pl?.rated ?? pl?.ranked}
        bot={pl?.bot}
        right={ms !== null ? <span className={`clock${g.status === 'active' && player === p ? ' running' : ''}${low(ms) ? ' low' : ''}`}>{formatClock(ms)}</span> : null}
      />
    );
  };

  const { green, brown } = counts(pos.board);
  const w = g.winner ?? 0;
  const title =
    w === 0 ? t('result.draw') : myColor ? (w === myColor ? t('result.win') : t('result.lose')) : t('result.sideWins', { color: sideName(w) });
  const delta = g.ratingChange && myColor ? (myColor === 1 ? g.ratingChange.green : g.ratingChange.brown) : null;
  const restriction = myColor ? g.ratingRestriction?.[myColor === 1 ? 'green' : 'brown'] : undefined;

  return (
    <GameLayout
      className="game"
      centered
      top={<TopBar onBack={() => go('')} />}
      above={row(-bottom as Player)}
      board={<Board pos={pos} interactive={myTurn && !mustPass} onMove={play} />}
      below={
        <>
          {row(bottom)}
          {g.status === 'finished' && !showResult && (
            <button className="btn" onClick={() => setShowResult(true)}>
              {t('result.show')}
            </button>
          )}
        </>
      }
      side={
        <>
          <OnlineMoves moves={g.moves} />
          <p className="kbd-hint">{t('keys.board')}</p>
        </>
      }
      moves={<OnlineMoves moves={g.moves} />}
      overlay={
        <>
      {g.status === 'finished' && showResult && (
        <ResultPopup
          title={title}
          sub={restriction ? t(`rating.restriction.${restriction}`) : g.endReason === 'timeout' ? t('og.byTimeout') : g.endReason === 'resign' ? t('og.byResign') : null}
          green={green}
          brown={brown}
          rating={delta !== null ? { after: me.rating, delta, ranked: me.rated ?? me.ranked } : null}
          primary={
            g.ranked
              ? {
                  label: t('result.again'),
                  onClick: () => {
                    queue(g.mode);
                    go('match', '', true);
                  },
                }
              : { label: t('result.again'), onClick: () => go('pvp', '', true) }
          }
          onReview={myColor ? () => go('replay', `o-${g.id}`) : undefined}
          onLobby={() => go('', '', true)}
          onClose={() => setShowResult(false)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
        </>
      }
    />
  );
}

/** 넓은 창의 수순. 수가 늘 때만 다시 계산 */
function OnlineMoves({ moves }: { moves: number[] }) {
  const list = useMemo(() => movesFromActions(moves), [moves]);
  const [preview, setPreview] = useState<number | null>(null);
  let before = startPosition(initial(), 1);
  if (preview !== null) for (const a of moves.slice(0, preview)) before = advance(before, a);
  return <><MoveList moves={list} onSelect={setPreview} />
    {preview !== null && moves[preview] !== undefined && <MovePreview key={preview} before={before} action={moves[preview]} ply={Math.floor(preview / 2) + 1} onClose={() => setPreview(null)} />}</>;
}
