import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Level } from '@gyeol/ai';
import { PASS, canonical, counts, formatMove, initial, legal, winner, type Player } from '@gyeol/core';
import { MovePreview } from '../components/MovePreview';
import { Board } from '../components/Board';
import { ResultPopup } from '../components/ResultPopup';
import { GameLayout, MoveList, type MoveEntry } from '../components/GameLayout';
import { useShortcuts } from '../lib/keys';
import { PlayerRow, TopBar } from '../components/ui';
import { aiMove, useAi, warmup } from '../ai/client';
import { advance, startPosition, type Position } from '../game/track';
import { useAutoPass } from '../game/useAutoPass';
import { aiStats, newRecordId, records } from '../lib/storage';
import { sideName } from '../lib/skins';
import { sound } from '../lib/sound';
import { t } from '../i18n';

export type GameConfig = { mode: 'ai'; level: Level; human: Player } | { mode: 'local' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Props {
  config: GameConfig;
  onHome: () => void;
  onReview: (recordId: string) => void;
}

export function GameScreen({ config, onHome, onReview }: Props) {
  const [history, setHistory] = useState<Position[]>(() => [startPosition(initial(), 1)]);
  const [loaded, setLoaded] = useState(config.mode === 'local');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(true);
  const [retry, setRetry] = useState(0);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const gen = useRef(0);

  useAi(config.mode === 'ai');
  const pos = history[history.length - 1];
  const end = winner(pos.board, pos.player);
  const mustPass = end === null && legal(pos.board, pos.player)[0] === PASS;
  const isAi = config.mode === 'ai';
  const aiTurn = isAi && end === null && pos.player !== config.human;
  const humanTurn = end === null && !aiTurn;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!isAi) return;
    warmup().then(
      () => setLoaded(true),
      (e: Error) => setError(e.message),
    );
  }, [isAi]);

  const play = useCallback((from: Position, a: number) => {
    const next = advance(from, a);
    if (a !== PASS) {
      sound.place();
      sound.flip(next.last?.flipped?.length ?? 0);
    }
    setHistory((h) => [...h, next]);
  }, []);

  useAutoPass(pos, mustPass, () => {
    play(pos, PASS);
    setToast(t('game.passed', { color: sideName(pos.player) }));
  });

  // AI 차례
  useEffect(() => {
    if (!aiTurn || mustPass || error) return;
    const g = ++gen.current;
    const started = performance.now();
    aiMove(canonical(pos.board, pos.player), (config as { level: Level }).level)
      .then(async (a) => {
        const wait = 500 - (performance.now() - started);
        if (wait > 0) await sleep(wait);
        if (gen.current !== g) return;
        play(pos, a);
        if (a === PASS) setToast(t('game.aiPassed'));
      })
      .catch((e: Error) => {
        if (gen.current === g) setError(e.message);
      });
    return () => {
      gen.current++;
    };
  }, [pos, aiTurn, mustPass, error, retry, config, play]);

  // 끝났을 때 기록 저장 (한 판에 한 번)
  useEffect(() => {
    if (end === null || recordId) return;
    sound.end();
    const id = newRecordId();
    const moves = history.slice(1).map((p) => p.action!);
    const c = counts(history[history.length - 1].board);
    const meColor: Player = config.mode === 'ai' ? config.human : 1;
    records.add({
      id,
      ruleVersion: 'facing-25-v1',
      mode: config.mode,
      date: Date.now(),
      moves,
      winner: end,
      score: meColor === 1 ? { me: c.green, opp: c.brown } : { me: c.brown, opp: c.green },
      me: config.mode === 'ai' ? config.human : null,
      level: config.mode === 'ai' ? config.level : undefined,
    });
    if (config.mode === 'ai') aiStats.add(config.level, end === 0 ? 'draw' : end === config.human ? 'win' : 'loss');
    setRecordId(id);
  }, [end, config, history, recordId]);

  const restart = () => {
    gen.current++;
    setRecordId(null);
    setShowResult(true);
    setPreview(null);
    setError(null);
    setHistory([startPosition(initial(), 1)]);
  };

  // 되돌리기: AI 대국은 내 차례였던 직전 국면으로
  let undoTo = -1;
  for (let j = history.length - 2; j >= 0; j--)
    if ((config.mode === 'local' || history[j].player === config.human)
      && legal(history[j].board, history[j].player)[0] !== PASS) {
      undoTo = j;
      break;
    }

  const undo = () => {
    if (undoTo < 0) return;
    gen.current++;
    setError(null);
    setHistory((h) => [...h.slice(0, undoTo), { ...h[undoTo], animate: false }]);
    setPreview(null);
  };

  // 단축키: 화면의 버튼이 보이고 켜져 있을 때만
  const buttonsShown = !(end !== null && !showResult);
  useShortcuts({
    KeyU: buttonsShown && undoTo >= 0 && undo,
    KeyN: buttonsShown && history.length >= 2 && restart,
  });

  const aiName = config.mode === 'ai' ? t('game.aiName', { level: t(`level.${config.level}`) }) : '';
  const names =
    config.mode === 'ai'
      ? config.human === 1
        ? { green: t('game.me'), brown: aiName }
        : { green: aiName, brown: t('game.me') }
      : undefined;

  const { green, brown } = counts(pos.board);
  let title = '';
  if (end !== null) {
    if (config.mode === 'ai') title = end === 0 ? t('result.draw') : end === config.human ? t('result.win') : t('result.lose');
    else title = end === 0 ? t('result.draw') : t('result.sideWins', { color: sideName(end) });
  }

  // 위: 상대(AI) 또는 후공, 아래: 나 또는 선공
  const bottom: Player = config.mode === 'ai' ? config.human : 1;
  const nameOf = (p: Player): ReactNode => (names ? (p === 1 ? names.green : names.brown) : sideName(p));
  const row = (p: Player) => (
    <PlayerRow
      color={p}
      name={nameOf(p)}
      right={
        aiTurn && p === pos.player && !error ? (
          <span className="spin" aria-label={loaded ? t('game.aiThinking') : t('game.aiLoading')} />
        ) : (
          <span className="count">{p === 1 ? green : brown}</span>
        )
      }
    />
  );

  const moveLog: MoveEntry[] = history.slice(1).map((p, i) => ({
    player: history[i].player,
    notation: formatMove(history[i].board, history[i].player, p.action!),
    action: p.action!,
  }));

  return (
    <GameLayout
      className="game"
      centered
      top={<TopBar onBack={onHome} />}
      above={row(-bottom as Player)}
      board={<Board pos={pos} interactive={humanTurn && !mustPass && !error} onMove={(a) => play(pos, a)} />}
      below={
        <>
          {row(bottom)}
          {mustPass && <p className="status" role="status">{t('game.mustPass')}</p>}
          {error && (
            <p className="status">
              {t('game.aiError')}{' '}
              <button
                className="link"
                onClick={() => {
                  setError(null);
                  setRetry((r) => r + 1);
                }}
              >
                {t('btn.tryAgain')}
              </button>
            </p>
          )}
        </>
      }
      side={
        <>
          <MoveList moves={moveLog} onSelect={setPreview} />
          <p className="kbd-hint">
            {t('keys.board')}
            <br />
            {t('keys.game')}
          </p>
        </>
      }
      moves={<MoveList moves={moveLog} onSelect={setPreview} />}
      footer={
      end !== null && !showResult ? (
        <button className="btn" onClick={() => setShowResult(true)}>
          {t('result.show')}
        </button>
      ) : (
        <div className="actions">
          <button className="btn" onClick={undo} disabled={undoTo < 0}>
            {t('btn.undo')}
          </button>
          <button className="btn" onClick={restart} disabled={history.length < 2}>
            {t('btn.newGame')}
          </button>
        </div>
      )
      }
      overlay={
        <>
          {preview !== null && history[preview + 1] && <MovePreview key={preview} before={history[preview]} action={history[preview + 1].action!} ply={Math.floor(preview / 2) + 1} onClose={() => setPreview(null)} />}
          {end !== null && showResult && (
            <ResultPopup
              title={title}
              green={green}
              brown={brown}
              primary={{ label: t('btn.again'), onClick: restart }}
              onReview={recordId ? () => onReview(recordId) : undefined}
              onLobby={onHome}
              onClose={() => setShowResult(false)}
            />
          )}
          {toast && <div className="toast">{toast}</div>}
        </>
      }
    />
  );
}
