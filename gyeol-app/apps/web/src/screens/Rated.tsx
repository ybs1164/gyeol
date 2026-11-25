import { useEffect, useRef, useState } from 'react';
import {
  PUZZLE_STAGES, PASS, bestReply, correctMoves, dailyPuzzle, legal, puzzleNumber, puzzleValues, pickRated, ratedPuzzle, ratingDelta, result, stageBand,
  stageOf, recommendedPuzzleRating, type Player, type RatedPuzzle,
} from '@gyeol/core';
import { Board, type Stage } from '../components/Board';
import { Score } from '../components/Score';
import { GameLayout } from '../components/GameLayout';
import { stageHint } from '../components/Hint';
import { Icon } from '../components/Icon';
import { StageBadge, TopBar } from '../components/ui';
import { advance, startPosition, type Position } from '../game/track';
import { useAutoPass } from '../game/useAutoPass';
import { puzzleLog, puzzleRating, type PuzzleDay, type PuzzleRating } from '../lib/storage';
import { sideName } from '../lib/skins';
import { sound } from '../lib/sound';
import { shareText } from '../lib/platform';
import { t } from '../i18n';
import { connect, useOnline, webUrl } from '../lib/online';
import { streak, solvedCount } from '../lib/puzzle-stats';
import { usePuzzleBank } from '../lib/puzzle-bank';
import type { Go } from '../App';

const stageName = (n: number) => t(`stage.${n}`);

/** 문제는 상대의 직전 실수를 판 위에 두고(마지막 수 표시) 시작한다. 실수 기록이 없는 이전 은행은 퍼즐 판에서 바로 시작한다. */
const startOf = (p: RatedPuzzle): Position =>
  p.mistake ? advance(startPosition(p.mistake.board, -p.player as Player), p.mistake.action) : startPosition(p.board, p.player);

/** 단계 n을 고를 수 있나: 지금 단계의 바로 위까지 */
const unlocked = (n: number, rating: number) => n <= stageOf(rating).n + 1;

/** 퍼즐 도전: 레이팅 · 단계 · 그래프 */
export function RatedHub({ go }: { go: Go }) {
  const online = useOnline();
  const [rec, setRec] = useState(() => puzzleRating.seedFromGame(online.me?.rating, online.me?.rated ?? online.me?.ranked));
  useEffect(() => {
    connect();
    setRec(puzzleRating.seedFromGame(online.me?.rating, online.me?.rated ?? online.me?.ranked));
  }, [online.me?.rating, online.me?.ranked]);
  const stage = stageOf(rec.rating);
  const [lo, hi] = stageBand(stage);
  const next = PUZZLE_STAGES[stage.n];
  const progress = Math.max(0, Math.min(1, (rec.rating - lo) / (hi - lo)));
  const pts = rec.history;
  const vlo = Math.min(...pts, lo) - 20;
  const vhi = Math.max(...pts, lo) + 20;
  const y = (v: number) => 40 - ((v - vlo) / (vhi - vlo)) * 40;

  return (
    <div className="screen">
      <TopBar onBack={() => go('')} title={t('rated.title')} />

      <div className="rating-hero">
        <StageBadge n={stage.n} size={56} />
        <div>
          <b>{rec.rating}</b>
          <small>{t('rated.ratingLabel')}</small>
          <small>
            {t('rated.stage', { n: stage.n })} · {stageName(stage.n)}
          </small>
        </div>
      </div>
      {next && (
        <div className="next">
          <div className="cap">
            <span>{t('rated.toNext', { n: next.n, name: stageName(next.n) })}</span>
            <b>{Math.max(0, next.min - rec.rating)}</b>
          </div>
          <div className="track">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}

      <div className="stats three">
        <div>
          <b>{rec.solved}</b>
          <span>{t('rated.solved')}</span>
        </div>
        <div>
          <b>{rec.played ? `${Math.round((rec.solved / rec.played) * 100)}%` : '–'}</b>
          <span>{t('rated.accuracy')}</span>
        </div>
        <div>
          <b>{rec.bestStreak}</b>
          <span>{t('rated.bestStreak')}</span>
        </div>
      </div>

      <div className="card chart">
        {pts.length < 2 ? (
          <div className="empty">{t('rated.empty')}</div>
        ) : (
          <>
            <svg viewBox="0 0 100 40" preserveAspectRatio="none">
              <line className="gl" x1="0" y1={y(lo)} x2="100" y2={y(lo)} />
              <polyline className="ln" points={pts.map((v, i) => `${(i / (pts.length - 1)) * 100},${y(v)}`).join(' ')} />
            </svg>
            <div className="cap">
              <span>{t('rated.recent', { n: pts.length - 1 })}</span>
              <span>{t('rated.peak', { n: rec.peak })}</span>
            </div>
          </>
        )}
      </div>

      <section>
        <p className="label">{t('rated.stages')}</p>
        <div className="group ladder stages">
          {[...PUZZLE_STAGES].reverse().map((s) => {
            const [a, b] = stageBand(s);
            const open = unlocked(s.n, rec.rating);
            const cur = s.n === stage.n;
            return (
              <button
                key={s.n}
                className={`item ${cur ? 'cur' : ''}`}
                disabled={!open}
                onClick={() => go('solve', String(s.n))}
              >
                <StageBadge n={s.n} size={30} />
                <span className="txt">
                  <b>
                    {t('rated.stage', { n: s.n })} · {stageName(s.n)}
                  </b>
                </span>
                {cur && <span className="pill go">{t('rating.current')}</span>}
                <span className="muted small stage-range">
                  {s.n === PUZZLE_STAGES.length ? `${a}~` : s.n === 1 ? `~${b - 1}` : `${a}~${b - 1}`}
                </span>
                {open ? <Icon name="chevron" className="chev" /> : <Icon name="lock" className="chev" />}
              </button>
            );
          })}
        </div>
      </section>

      <div className="spacer" />
      <button className="btn primary play" onClick={() => go('solve')}>
        {t('rated.start')}
      </button>
    </div>
  );
}

type Phase = 'solve' | 'reply' | 'demo' | 'done';

interface Outcome {
  solved: boolean;
  /** 레이팅 반영 결과 (연습 풀이면 null) */
  delta: number | null;
  before: PuzzleRating | null;
  after: PuzzleRating | null;
  /** 상대가 최선으로 막았을 때의 종국 결과. 양수만 승리다. */
  got?: number;
  /** 한 수 문제: 둔 수와 정답의 평가(exact 는 1/0/-1, ai 는 승률) */
  keep?: { played: number; best: number };
}

/** 한 수 문제의 결과 설명 한 줄 */
function keepExplain(puzzle: RatedPuzzle, o: Outcome): string {
  if (!o.keep) return '';
  const pct = (v: number) => Math.round(v * 100);
  if (puzzle.judge === 'exact') {
    if (o.solved) return t('rated.keep.exactOk');
    return t(o.keep.played === 0 ? 'rated.keep.exactDraw' : 'rated.keep.exactLoss');
  }
  return o.solved ? t('rated.keep.aiOk', { p: pct(o.keep.best) }) : t('rated.keep.aiNo', { p: pct(o.keep.played), best: pct(o.keep.best) });
}

/** 목표 레이팅: 단계를 골랐으면 그 구간 안 무작위, 아니면 내 레이팅 근처 */
function targetFor(stageN: number | null, rating: number): number {
  if (!stageN) return recommendedPuzzleRating(rating);
  const [lo, hi] = stageBand(PUZZLE_STAGES[stageN - 1]);
  return lo + Math.random() * (hi - lo);
}

function nextPuzzle(stageN: number | null): RatedPuzzle {
  const rec = puzzleRating.get();
  const cur = rec.current ? ratedPuzzle(rec.current) : null;
  if (cur) {
    // 풀던 퍼즐이 지금 고른 단계에 맞으면 이어서 (나갔다 와서 건너뛰기 방지)
    const s = stageN ? PUZZLE_STAGES[stageN - 1] : null;
    const [lo, hi] = s ? stageBand(s) : [-Infinity, Infinity];
    if (cur.rating >= lo && cur.rating < hi && (!s || s.kinds.includes(cur.kind))) return cur;
  }
  const e = pickRated(targetFor(stageN, rec.rating), new Set(rec.seen), Math.random, stageN ?? undefined);
  puzzleRating.set({ current: e.id });
  return ratedPuzzle(e.id)!;
}

type SolveProps = { go: Go; stage: string; daily?: { key: string; onHome: () => void; onMore: () => void } };

/** 퍼즐은 서버가 만든 은행에서 낸다. 받기 전(처음 실행)에는 기다리거나 다시 받는다. */
export function RatedSolve(props: SolveProps) {
  const bank = usePuzzleBank();
  if (bank.status === 'ready') return <RatedSolveReady {...props} />;
  const { go, daily } = props;
  return (
    <div className="screen">
      <TopBar onBack={daily ? daily.onHome : () => go('puzzles')} title={daily ? t('puzzle.title', { n: puzzleNumber(daily.key) }) : t('rated.title')} />
      <div className="spacer" />
      <p className="status" role="status">{bank.status === 'loading' ? <><span className="spin" /> {t('puzzle.bankLoading')}</> : t('puzzle.bankError')}</p>
      <div className="spacer" />
      {bank.status === 'error' && <button className="btn primary play" onClick={bank.retry}>{t('puzzle.bankRetry')}</button>}
    </div>
  );
}

/** 레이팅 퍼즐 풀기: 한 문제씩 끝없이 */
function RatedSolveReady({ go, stage: stageParam, daily }: SolveProps) {
  const online = useOnline();
  const [day, setDay] = useState<PuzzleDay>(() => daily ? puzzleLog.get(daily.key) : { attempts: [], solved: false });
  const stageN = /^[1-8]$/.test(stageParam) ? Number(stageParam) : null;
  const [puzzle, setPuzzle] = useState<RatedPuzzle>(() => {
    if (daily) return dailyPuzzle(daily.key, day.puzzleId);
    puzzleRating.seedFromGame(online.me?.rating, online.me?.rated ?? online.me?.ranked);
    return nextPuzzle(stageN);
  });
  const [pos, setPos] = useState<Position>(() => startOf(puzzle));
  const [ownMoves, setOwnMoves] = useState(0);
  const [phase, setPhase] = useState<Phase>(daily && day.solved ? 'done' : 'solve');
  const [stage, setStage] = useState<Stage>('tile');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** 이번 퍼즐의 첫 풀이인가 (다시 풀기·정답 보기는 레이팅에 반영하지 않음) */
  const rated = useRef(!daily && !puzzleRating.get().seen.includes(puzzle.id));
  const dailyAttemptFinished = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [rec, setRec] = useState(() => puzzleRating.get());

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (daily && day.puzzleId !== puzzle.id) {
      const updated = { ...day, puzzleId: puzzle.id };
      puzzleLog.set(daily.key, updated);
      setDay(updated);
    }
  }, [daily?.key, day, puzzle.id]);

  const me = puzzle.player;

  /** 결과를 정한다. 첫 풀이면 레이팅에 반영 */
  const settle = (solved: boolean, got?: number): Outcome => {
    if (daily) {
      if (!dailyAttemptFinished.current && !day.solved) {
        dailyAttemptFinished.current = true;
        const updated = { ...day, puzzleId: puzzle.id, attempts: [...day.attempts, solved ? 1 : 0], solved };
        puzzleLog.set(daily.key, updated);
        setDay(updated);
      }
      return { solved, delta: null, before: null, after: null, got };
    }
    if (!rated.current) return { solved, delta: null, before: null, after: null, got };
    rated.current = false;
    const before = puzzleRating.get();
    const after = puzzleRating.record(puzzle.id, solved, ratingDelta(before.rating, puzzle.rating, solved, before.played));
    setRec(after);
    return { solved, delta: after.rating - before.rating, before, after, got };
  };

  const show = (o: Outcome) => {
    setOutcome(o);
    setPhase('done');
    if (o.solved) sound.end();
  };

  /** 상대가 가장 좋은 수로 받는다. 다 둔 뒤 then(판) */
  const reply = (from: Position, then: (p: Position) => void) => {
    setPhase('reply');
    timer.current = setTimeout(() => {
      const next = advance(from, bestReply(puzzle, from.board, from.player));
      if (!next.last?.pass) {
        sound.place();
        sound.flip(next.last?.flipped?.length ?? 0);
      }
      setPos(next);
      timer.current = setTimeout(() => then(next), 650);
    }, 650);
  };

  const move = (a: number) => {
    const values = puzzleValues(puzzle, pos.board, pos.player);
    const ok = correctMoves(puzzle.kind, values).includes(a);
    const got = values.get(a);
    const next = advance(pos, a);
    if (a !== PASS) {
      sound.place();
      sound.flip(next.last?.flipped?.length ?? 0);
    }
    setPos(next);
    setOwnMoves((n) => n + 1);
    if (puzzle.format === 'move') {
      // 한 수 문제: 상대 응수 없이 이 수가 유리함을 지키는지로 바로 판정한다
      const evals = new Map(puzzle.evals);
      const best = Math.max(...[...values].filter(([, v]) => v > 0).map(([x]) => evals.get(x)!));
      show({ ...settle(ok), keep: { played: evals.get(a)!, best } });
      return;
    }
    const over = result(next.board, next.player) !== 0;

    if (!ok) {
      // 틀리면 바로 기록하고(응수를 보는 중에 나가도 반영), 상대가 어떻게 받는지 보여준다
      const o = settle(false, got);
      if (over) show(o);
      else reply(next, () => show(o));
      return;
    }
    if (over) {
      show(settle(result(next.board, me) > 0.5, got));
      return;
    }
    reply(next, (p) => {
      if (result(p.board, p.player) !== 0) show(settle(result(p.board, me) > 0.5, got));
      else {
        setPhase('solve');
      }
    });
  };

  const reset = () => {
    clearTimeout(timer.current);
    setPos(startOf(puzzle));
    setOwnMoves(0);
    dailyAttemptFinished.current = false;
    setPhase('solve');
    setOutcome(null);
  };

  /** 정답 수순을 처음부터 차례로 보여준다 (상대는 최선 응수). 레이팅과 무관 */
  const showSolution = () => {
    clearTimeout(timer.current);
    let p = startOf(puzzle);
    let steps = 0;
    setPos(p);
    setOutcome(null);
    setPhase('demo');
    const step = () => {
      if (result(p.board, p.player) !== 0 || (puzzle.format === 'move' && steps > 0)) {
        setPhase('done');
        return;
      }
      if (++steps > 2 * (25 - puzzle.board.filter(Boolean).length) + 1) throw new Error('검증된 풀이의 길이를 초과했습니다');
      const winning = p.player === me ? correctMoves(puzzle.kind, puzzleValues(puzzle, p.board, p.player)) : [];
      const a = p.player === me
        ? steps === 1 && winning.includes(puzzle.source.playedMove) ? puzzle.source.playedMove : winning[0]
        : bestReply(puzzle, p.board, p.player);
      p = advance(p, a);
      sound.place();
      sound.flip(p.last?.flipped?.length ?? 0);
      setPos(p);
      timer.current = setTimeout(step, 1000);
    };
    timer.current = setTimeout(step, 500);
  };

  const nextOne = () => {
    clearTimeout(timer.current);
    const p = nextPuzzle(stageN);
    rated.current = !puzzleRating.get().seen.includes(p.id);
    setPuzzle(p);
    setPos(startOf(p));
    setOwnMoves(0);
    setPhase('solve');
    setOutcome(null);
  };

  const stageNow = stageOf(rec.rating);
  const stageUp = outcome?.before && outcome.after && stageOf(outcome.after.rating).n > stageOf(outcome.before.rating).n;
  const second = ownMoves > 0 && phase === 'solve';
  const mustPass = phase === 'solve' && legal(pos.board, pos.player)[0] === PASS;
  useAutoPass(pos, mustPass, () => move(PASS));

  const status =
    phase === 'demo'
      ? t('rated.demo')
      : phase === 'reply'
      ? t('rated.replying', { opp: sideName(pos.player) })
      : mustPass
        ? t('game.mustPass')
      : second
        ? t('rated.again')
        : stageHint(stage, pos.player);

  const shareDaily = async () => {
    if (!daily) return;
    const text = t('puzzle.share', { n: puzzleNumber(daily.key), marks: day.attempts.map((n) => n === 1 ? '🟩' : '⬜').join(''), tries: day.attempts.length }) + `\n${webUrl()}/#/puzzle`;
    await shareText(text);
  };

  return (
    <GameLayout
      top={
      <TopBar
        onBack={daily ? daily.onHome : () => go('puzzles')}
        title={daily ? t('puzzle.title', { n: puzzleNumber(daily.key) }) : t('rated.title')}
        right={
          daily ? <span className="muted small">{daily.key}</span> : <span className="rated-chip">
            <StageBadge n={stageNow.n} size={22} />
            <b>{rec.rating}</b>
          </span>
        }
      />
      }
      above={
        <>
      {(stageN || rec.streak > 1) && (
        <div className="rated-meta">
          {stageN && <span className="muted small">{t('rated.stage', { n: stageN })}</span>}
          {rec.streak > 1 && <span className="pill go streak">{t('rated.streakN', { n: rec.streak })}</span>}
        </div>
      )}

      <Score board={pos.board} turn={phase === 'done' ? null : pos.player} />
        </>
      }
      side={<p className="kbd-hint">{t('keys.board')}</p>}
      board={
      <Board
        key={puzzle.id}
        pos={pos}
        interactive={phase === 'solve' && !mustPass}
        onMove={move}
        onStage={setStage}
        showLast={pos.action !== undefined}
      />
      }
      below={
        <>
      {phase !== 'done' && <p className="status">{status}</p>}

      {phase === 'done' && !outcome && <p className="status">{t(daily && day.solved ? 'puzzle.completed' : 'rated.demoDone')}</p>}
      {phase === 'done' && outcome && (
        <div className={`panel rated-result ${outcome.solved ? 'ok' : 'no'}`}>
          <div className="head">
            <h3>{outcome.solved ? t('rated.ok') : t('rated.no')}</h3>
            {outcome.delta !== null && outcome.after && (
              <span className="rchg">
                <b>{outcome.after.rating}</b>
                <em className={outcome.delta >= 0 ? 'plus' : 'minus'}>
                  {outcome.delta >= 0 ? `+${outcome.delta}` : `−${-outcome.delta}`}
                </em>
              </span>
            )}
          </div>
          {outcome.keep && <p className="small">{keepExplain(puzzle, outcome)}</p>}
          {stageUp && outcome.after && (
            <p className="stage-up">
              <StageBadge n={stageOf(outcome.after.rating).n} size={26} />
              {t('rated.stageUp', { n: stageOf(outcome.after.rating).n, name: stageName(stageOf(outcome.after.rating).n) })}
            </p>
          )}
        </div>
      )}
        </>
      }
      footer={
        <>
      {daily && day.solved && <div className="stats three">
        <div><b>{day.attempts.length}</b><span>{t('puzzle.attempts')}</span></div>
        <div><b>{streak()}</b><span>{t('puzzle.streak')}</span></div>
        <div><b>{solvedCount()}</b><span>{t('puzzle.solved')}</span></div>
      </div>}
      {phase === 'done' && (
        <div className="actions rated-actions">
          <div className="row2">
            <button className="btn" onClick={reset}>
              {t('rated.retry')}
            </button>
            <button className="btn" onClick={showSolution}>
              {t('rated.showSolution')}
            </button>
          </div>
          {daily && day.solved && <button className="btn" onClick={shareDaily}>{t('btn.share')}</button>}
          <button className="btn primary play" onClick={daily ? daily.onMore : nextOne}>
            {t(daily ? 'puzzle.more' : 'rated.next')}
          </button>
        </div>
      )}
        </>
      }
    />
  );
}
