import { useEffect } from 'react';
import { connect, send, useOnline } from '../lib/online';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import type { Go } from '../App';

/** 초대 링크(#/join/코드)로 들어왔을 때 */
export function Join({ code, go }: { code: string; go: Go }) {
  const s = useOnline();

  useEffect(() => {
    connect();
    send({ t: 'join', code });
  }, [code]);

  useEffect(() => {
    const g = Object.values(s.games).find((x) => x.code === code.toUpperCase() && x.status !== 'finished');
    if (g) go('g', g.id, true);
  }, [s.games, code, go]);

  const failed = s.lastError && ['not_found', 'full'].includes(s.lastError.code);
  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" onClick={() => go('pvp')} aria-label={t('nav.back')}>
          <Icon name="back" />
        </button>
        <h2>{t('online.friend')}</h2>
      </div>
      <div className="spacer" />
      <div className="panel center-text">
        <div className="code">{code.toUpperCase()}</div>
        {failed ? (
          <p className="text">{t(`err.${s.lastError!.code}`)}</p>
        ) : s.status === 'offline' ? (
          <p className="text">{s.url ? t('online.offline') : t('online.noServer')}</p>
        ) : (
          <p className="text">
            <span className="spin" />
            {t('join.joining')}
          </p>
        )}
      </div>
      <div className="spacer" />
    </div>
  );
}
