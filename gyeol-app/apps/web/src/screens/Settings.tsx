import { useState, type CSSProperties } from 'react';
import { LANGS, t } from '../i18n';
import { settings, type LangSetting, type SkinId, type ThemeSetting } from '../lib/storage';
import { SKINS, applySkin, applyTheme } from '../lib/skins';
import { canVibrate } from '../lib/platform';
import { Icon } from '../components/Icon';
import { NicknamePopup } from '../components/NicknamePopup';
import { Popup } from '../components/ui';
import { Arrow } from '../components/Board';
import { AppShell } from '../components/AppShell';
import type { Go, Route } from '../App';

export const APP_VERSION = '0.4.1';

const LICENSES: [string, string][] = [
  ['React', 'MIT'],
  ['ONNX Runtime Web', 'MIT'],
  ['Capacitor', 'MIT'],
  ['Vite PWA · Workbox', 'MIT'],
];

interface Props {
  go: Go;
  route: Route;
  /** 언어·색이 바뀌면 앱 전체를 다시 그린다 */
  onChange: () => void;
}

type Sheet = 'nickname' | 'lang' | 'theme' | 'licenses' | null;

export function Settings({ go, route, onChange }: Props) {
  const [s, setS] = useState(settings.get());
  const [sheet, setSheet] = useState<Sheet>(null);

  const patch = (p: Partial<typeof s>, rerender = false) => {
    settings.set(p);
    setS(settings.get());
    if (p.skin) applySkin(p.skin);
    if (p.theme) applyTheme(p.theme);
    if (rerender) onChange();
  };

  const langName = s.lang === 'auto' ? t('set.auto') : LANGS.find((l) => l.id === s.lang)?.name;
  const themes: ThemeSetting[] = ['auto', 'light', 'dark'];
  const chev = <Icon name="chevron" className="chev" />;

  return (
    <AppShell route={route} go={go} width="narrow">
      <h2 className="page-title">{t('tab.settings')}</h2>

      <section>
        <p className="label">{t('set.account')}</p>
        <div className="group">
          <button className="row-v" onClick={() => setSheet('nickname')}>
            <span className="k">{t('start.nickname')}</span>
            <span className="v">{s.nickname}</span>
            {chev}
          </button>
          <div className="row-v">
            <span className="k">{t('set.link')}</span>
            <span className="v">{t('set.guest')}</span>
          </div>
        </div>
      </section>

      <section>
        <p className="label">{t('set.skin')}</p>
        <div className="skins">
          {SKINS.map((k) => (
            <button key={k.id} className="skin" aria-pressed={s.skin === k.id} onClick={() => patch({ skin: k.id as SkinId }, true)}>
              <span className="pair">
                <span className="mini" style={{ '--s': '26px', '--c': k.preview[0], color: k.preview[1] } as CSSProperties}>
                  <Arrow />
                </span>
                <span className="mini" style={{ '--s': '26px', '--c': k.preview[2], color: k.preview[3] } as CSSProperties}>
                  <Arrow />
                </span>
              </span>
              <b>{t(`skin.${k.id}`)}</b>
            </button>
          ))}
        </div>
      </section>

      <section>
        <p className="label">{t('set.game')}</p>
        <div className="group">
          <button className="row-v" role="switch" aria-checked={s.sound} onClick={() => patch({ sound: !s.sound })}>
            <span className="k">{t('set.sound')}</span>
            <span className={`switch ${s.sound ? 'on' : ''}`} />
          </button>
          <button className="row-v" role="switch" aria-checked={s.coordinates} onClick={() => patch({ coordinates: !s.coordinates })}>
            <span className="k">{t('notation.coordinates')}</span>
            <span className={`switch ${s.coordinates ? 'on' : ''}`} />
          </button>
          {/* 진동이 없는 기기(데스크톱 · iOS)에서는 켜도 아무 일이 없으므로 보이지 않는다 */}
          {canVibrate() && (
            <button className="row-v" role="switch" aria-checked={s.vibrate} onClick={() => patch({ vibrate: !s.vibrate })}>
              <span className="k">{t('set.vibrate')}</span>
              <span className={`switch ${s.vibrate ? 'on' : ''}`} />
            </button>
          )}
        </div>
      </section>

      <section>
        <p className="label">{t('set.general')}</p>
        <div className="group">
          <button className="row-v" onClick={() => setSheet('lang')}>
            <span className="k">{t('set.lang')}</span>
            <span className="v">{langName}</span>
            {chev}
          </button>
          <button className="row-v" onClick={() => setSheet('theme')}>
            <span className="k">{t('set.theme')}</span>
            <span className="v">{t(`set.theme.${s.theme}`)}</span>
            {chev}
          </button>
        </div>
      </section>

      <section>
        <p className="label">{t('set.info')}</p>
        <div className="group">
          <div className="row-v">
            <span className="k">{t('set.version')}</span>
            <span className="v">{APP_VERSION}</span>
          </div>
          <button className="row-v" onClick={() => setSheet('licenses')}>
            <span className="k">{t('set.licenses')}</span>
            {chev}
          </button>
        </div>
      </section>

      {sheet === 'nickname' && (
        <NicknamePopup
          onClose={(changed) => {
            setSheet(null);
            if (changed) setS(settings.get());
          }}
        />
      )}
      {sheet === 'lang' && (
        <Popup onClose={() => setSheet(null)}>
          <h3>{t('set.lang')}</h3>
          <div className="group">
            {[{ id: 'auto' as LangSetting, name: t('set.auto') }, ...LANGS].map((l) => (
              <button
                key={l.id}
                className="row-v"
                aria-pressed={s.lang === l.id}
                onClick={() => {
                  setSheet(null);
                  patch({ lang: l.id as LangSetting }, true);
                }}
              >
                <span className="k">{l.name}</span>
              </button>
            ))}
          </div>
        </Popup>
      )}
      {sheet === 'theme' && (
        <Popup onClose={() => setSheet(null)}>
          <h3>{t('set.theme')}</h3>
          <div className="group">
            {themes.map((x) => (
              <button
                key={x}
                className="row-v"
                aria-pressed={s.theme === x}
                onClick={() => {
                  setSheet(null);
                  patch({ theme: x });
                }}
              >
                <span className="k">{t(`set.theme.${x}`)}</span>
              </button>
            ))}
          </div>
        </Popup>
      )}
      {sheet === 'licenses' && (
        <Popup onClose={() => setSheet(null)}>
          <h3>{t('set.licenses')}</h3>
          <div className="group">
            {LICENSES.map(([name, lic]) => (
              <div key={name} className="row-v">
                <span className="k">{name}</span>
                <span className="v">{lic}</span>
              </div>
            ))}
          </div>
          <button className="btn sm" onClick={() => setSheet(null)}>
            {t('btn.done')}
          </button>
        </Popup>
      )}
    </AppShell>
  );
}
