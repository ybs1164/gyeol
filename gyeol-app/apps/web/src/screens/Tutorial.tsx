import { useState } from 'react';
import { LESSONS, PASS, legal, type LessonCheck } from '@gyeol/core';
import { Board, type Stage } from '../components/Board';
import { Score } from '../components/Score';
import { GameLayout } from '../components/GameLayout';
import { stageHint } from '../components/Hint';
import { advance, startPosition } from '../game/track';
import { useAutoPass } from '../game/useAutoPass';
import { settings } from '../lib/storage';
import { sound } from '../lib/sound';
import { Icon } from '../components/Icon';
import { t } from '../i18n';

interface Props {
  onHome: () => void;
  onPlayAi: () => void;
}

export function Tutorial({ onHome, onPlayAi }: Props) {
  const [index, setIndex] = useState(0);
  const lesson = LESSONS[index];
  const [pos, setPos] = useState(() => startPosition(lesson.board, lesson.player));
  const [check, setCheck] = useState<LessonCheck | null>(null);
  const [stage, setStage] = useState<Stage>('tile');
  const [finished, setFinished] = useState(false);

  const done = lesson.kind === 'info' || check?.ok === true;
  const tried = pos.action !== undefined;
  const mustPass = lesson.kind === 'move' && !tried && legal(pos.board, pos.player)[0] === PASS;

  const open = (i: number) => {
    const l = LESSONS[i];
    setIndex(i);
    setPos(startPosition(l.board, l.player));
    setCheck(null);
  };

  const reset = () => {
    setPos(startPosition(lesson.board, lesson.player));
    setCheck(null);
  };

  const move = (a: number) => {
    const next = advance(pos, a);
    if (a !== PASS) {
      sound.place();
      sound.flip(next.last?.flipped?.length ?? 0);
    }
    setPos(next);
    setCheck(lesson.check!(a, next.last!));
  };

  const next = () => {
    if (index < LESSONS.length - 1) open(index + 1);
    else {
      settings.set({ tutorialDone: true });
      setFinished(true);
    }
  };

  useAutoPass(pos, mustPass && !finished, () => move(PASS));

  if (finished)
    return (
      <div className="screen">
        <div className="topbar">
          <button className="icon-btn" onClick={onHome} aria-label={t('nav.back')}>
          <Icon name="back" />
        </button>
          <h2>{t('learn.title')}</h2>
        </div>
        <div className="spacer" />
        <div className="panel">
          <h3>{t('learn.ready')}</h3>
          <p className="text">{t('learn.readyText')}</p>
          <button className="btn primary" onClick={onPlayAi}>
            {t('learn.playEasy')}
          </button>
          <button className="btn center" onClick={onHome}>
            {t('btn.home')}
          </button>
        </div>
        <div className="spacer" />
      </div>
    );

  return (
    <GameLayout
      top={
      <div className="topbar">
        <button className="icon-btn" onClick={onHome} aria-label={t('nav.back')}>
          <Icon name="back" />
        </button>
        <h2>
          {index + 1}. {t(`lesson.${lesson.id}.title`)}
        </h2>
        <div className="dots" aria-label={`${index + 1} / ${LESSONS.length}`}>
          {LESSONS.map((l, i) => (
            <i key={l.id} className={i <= index ? 'on' : ''} />
          ))}
        </div>
      </div>
      }
      above={
        <>
      <p className="text">{t(`lesson.${lesson.id}.text`)}</p>

      {lesson.kind === 'move' && <Score board={pos.board} turn={tried ? null : pos.player} />}
        </>
      }
      side={<p className="kbd-hint">{t('keys.board')}</p>}
      board={
      <Board
        pos={pos}
        interactive={lesson.kind === 'move' && !tried && !mustPass}
        onMove={move}
        onStage={setStage}
        showLast={tried}
      />
      }
      below={
      check ? (
        <p className={`feedback ${check.ok ? 'ok' : 'no'}`}>{t(check.key)}</p>
      ) : lesson.kind === 'move' ? (
        <p className="status">{mustPass ? <strong>{t('learn.noMove')}</strong> : stageHint(stage, pos.player)}</p>
      ) : null
      }
      footer={
      <div className="actions">
        {index > 0 && (
          <button className="btn" onClick={() => open(index - 1)}>
            {t('btn.prev')}
          </button>
        )}
        {tried && (
          <button className="btn" onClick={reset}>
            {t('btn.retry')}
          </button>
        )}
        {!mustPass && (
          <button className="btn primary" onClick={next} disabled={!done}>
            {index < LESSONS.length - 1 ? t('btn.next') : t('btn.done')}
          </button>
        )}
      </div>
      }
    />
  );
}
