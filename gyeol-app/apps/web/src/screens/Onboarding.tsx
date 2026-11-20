import { useState } from 'react';
import { NAME_MAX, validName } from '@gyeol/core';
import { settings } from '../lib/storage';
import { connect, syncName } from '../lib/online';
import { t } from '../i18n';

const base = import.meta.env.BASE_URL;

/** 로고: 앱을 열면 잠깐 */
export function Splash() {
  return (
    <div className="splash" aria-hidden>
      <img className="brand-mark" src={`${base}tiles/hero.svg`} alt="" />
      <h1>결</h1>
      <div className="ko">결</div>
    </div>
  );
}

/** 처음 한 번: 닉네임 정하고 시작 */
export function Start({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const ok = validName(name);

  const start = () => {
    if (!ok) return;
    settings.set({ nickname: name.trim() });
    connect();
    syncName();
    onDone();
  };

  return (
    <form
      className="screen"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <div className="intro">
        <img className="brand-mark" src={`${base}tiles/hero.svg`} alt="" />
        <h1>결</h1>
      </div>
      <div className="spacer" />
      <label className="field">
        <span>{t('start.nickname')}</span>
        <input className="input" value={name} maxLength={NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="btn primary" type="submit" disabled={!ok}>
        {t('start.go')}
      </button>
    </form>
  );
}
