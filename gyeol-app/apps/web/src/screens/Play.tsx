import { useEffect, useState } from 'react';
import { TIME_MODES, type TimeMode } from '@gyeol/core';
import { connect, queue, send, takeCreated, useOnline } from '../lib/online';
import { settings } from '../lib/storage';
import { Icon } from '../components/Icon';
import { Popup, TopBar } from '../components/ui';
import { t } from '../i18n';
import type { Go } from '../App';

/** 플레이: 시간 모드 고르기 + 친구와 두기 → 매칭 */
export function Play({ go }: { go: Go }) {
  const s = useOnline();
  const [mode, setMode] = useState<TimeMode>(settings.get().timeMode);
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');

  useEffect(() => {
    connect();
  }, []);

  // 친구 방을 만들면 바로 그 대기실로
  useEffect(() => {
    const c = takeCreated();
    if (c) go('g', c, true);
  }, [s.created, go]);

  const pick = (m: TimeMode) => {
    setMode(m);
    settings.set({ timeMode: m });
  };

  return (
    <div className="screen">
      <TopBar onBack={() => go('')} title={t('play.title')} />

      <section>
        <p className="label">{t('play.ranked')}</p>
        <div className="modes">
          {TIME_MODES.map((m) => (
            <button key={m.id} className="mode" aria-pressed={mode === m.id} onClick={() => pick(m.id)}>
              <Icon name={m.id} />
              <b>{t(`mode.${m.id}`)}</b>
              <small>{t(`modeName.${m.id}`)}</small>
            </button>
          ))}
        </div>
      </section>

      <section>
        <p className="label">{t('play.friend')}</p>
        <div className="row2">
          <button className="btn sm" onClick={() => send({ t: 'create', color: 'random', mode })}>
            <Icon name="invite" />
            {t('play.invite')}
          </button>
          <button className="btn sm" onClick={() => setJoining(true)}>
            <Icon name="code" />
            {t('play.code')}
          </button>
        </div>
      </section>

      {s.status === 'offline' && <p className="status">{s.url ? t('online.offline') : t('online.noServer')}</p>}

      <div className="spacer" />
      <button
        className="btn primary play"
        disabled={s.status === 'offline'}
        onClick={() => {
          queue(mode);
          go('match');
        }}
      >
        {t('play.start')}
      </button>

      {joining && (
        <Popup onClose={() => setJoining(false)}>
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim().length === 5) go('join', code.trim().toUpperCase());
            }}
          >
            <h3>{t('play.code')}</h3>
            <input
              className="input"
              value={code}
              maxLength={5}
              autoFocus
              autoCapitalize="characters"
              placeholder={t('online.codePlaceholder')}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <div className="row2" style={{ marginTop: 6 }}>
              <button type="button" className="btn sm" onClick={() => setJoining(false)}>
                {t('btn.cancel')}
              </button>
              <button type="submit" className="btn sm primary" disabled={code.trim().length < 5}>
                {t('btn.join')}
              </button>
            </div>
          </form>
        </Popup>
      )}
    </div>
  );
}
