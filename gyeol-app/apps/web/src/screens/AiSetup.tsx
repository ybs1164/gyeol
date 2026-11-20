import { useState } from 'react';
import { LEVELS, type Level } from '@gyeol/ai';
import type { Player } from '@gyeol/core';
import { aiStats, settings, type Settings } from '../lib/storage';
import { sideName } from '../lib/skins';
import { Icon } from '../components/Icon';
import { t } from '../i18n';

interface Props {
  onBack: () => void;
  onStart: (level: Level, human: Player) => void;
}

export function AiSetup({ onBack, onStart }: Props) {
  const saved = settings.get();
  const [level, setLevel] = useState<Level>(saved.level);
  const [color, setColor] = useState<Settings['color']>(saved.color);
  const stats = aiStats.get();
  const colors: { id: Settings['color']; name: string }[] = [
    { id: 'green', name: t('ai.first', { color: sideName(1) }) },
    { id: 'brown', name: t('ai.second', { color: sideName(-1) }) },
    { id: 'random', name: t('ai.random') },
  ];

  const start = () => {
    settings.set({ level, color });
    const human: Player = color === 'green' ? 1 : color === 'brown' ? -1 : Math.random() < 0.5 ? 1 : -1;
    onStart(level, human);
  };

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label={t('nav.back')}>
          <Icon name="back" />
        </button>
        <h2>{t('ai.title')}</h2>
      </div>

      <section>
        <p className="label">{t('ai.level')}</p>
        <div className="choices">
          {LEVELS.map((l) => {
            const s = stats[l.id];
            const played = s.win + s.loss + s.draw;
            return (
              <button key={l.id} className="choice" aria-pressed={level === l.id} onClick={() => setLevel(l.id)}>
                {t(`level.${l.id}`)}
                <small>{t(`level.${l.id}.desc`)}</small>
                {played > 0 && (
                  <span className="badge">
                    {s.draw ? t('ai.recordDraw', { w: s.win, l: s.loss, d: s.draw }) : t('ai.record', { w: s.win, l: s.loss })}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <p className="label">{t('ai.myColor')}</p>
        <div className="choices inline">
          {colors.map((c) => (
            <button key={c.id} className="choice" aria-pressed={color === c.id} onClick={() => setColor(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      </section>

      <div className="spacer" />
      <button className="btn primary" onClick={start}>
        {t('btn.start')}
      </button>
    </div>
  );
}
