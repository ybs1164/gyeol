import { useEffect, useState } from 'react';
import { takeMatched, unqueue, useOnline } from '../lib/online';
import { SpinTile } from '../components/ui';
import { t } from '../i18n';
import type { Go } from '../App';

/** 매칭 중: 도는 타일 + 기다린 시간 */
export function Matching({ go }: { go: Go }) {
  const s = useOnline();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // 잡히면 그 대국으로
  useEffect(() => {
    const m = takeMatched();
    if (m) go('g', m, true);
  }, [s.matched, go]);

  // 대기열에 없으면 (새로 고침 등) 플레이 화면으로
  useEffect(() => {
    if (!s.queued && !s.matched && s.status === 'online') go('pvp', '', true);
  }, [s.queued, s.matched, s.status, go]);

  const sec = s.queuedAt ? Math.max(0, Math.floor((now - s.queuedAt) / 1000)) : 0;

  return (
    <div className="screen">
      <div className="matching">
        <SpinTile />
        <div className="wait-time">
          {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}
        </div>
        {s.status === 'offline' && <p className="status">{t('online.offline')}</p>}
      </div>
      <button
        className="btn"
        onClick={() => {
          unqueue();
          go('pvp', '', true);
        }}
      >
        {t('btn.cancel')}
      </button>
    </div>
  );
}
