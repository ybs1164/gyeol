import { useState } from 'react';
import { NAME_MAX, validName } from '@gyeol/core';
import { settings } from '../lib/storage';
import { syncName } from '../lib/online';
import { Popup } from './ui';
import { t } from '../i18n';

/** 닉네임 바꾸기 (로비 연필 · 설정) */
export function NicknamePopup({ onClose }: { onClose: (changed: boolean) => void }) {
  const [name, setName] = useState(settings.get().nickname);
  const ok = validName(name);
  return (
    <Popup onClose={() => onClose(false)}>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          settings.set({ nickname: name.trim() });
          syncName();
          onClose(true);
        }}
      >
        <h3>{t('start.nickname')}</h3>
        <input className="input" value={name} maxLength={NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} />
        <div className="row2" style={{ marginTop: 6 }}>
          <button type="button" className="btn sm" onClick={() => onClose(false)}>
            {t('btn.cancel')}
          </button>
          <button type="submit" className="btn sm primary" disabled={!ok}>
            {t('btn.save')}
          </button>
        </div>
      </form>
    </Popup>
  );
}
