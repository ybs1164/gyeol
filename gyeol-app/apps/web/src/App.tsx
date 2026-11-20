import { useCallback, useEffect, useState } from 'react';
import { AiSetup } from './screens/AiSetup';
import { GameScreen, type GameConfig } from './screens/GameScreen';
import { Tutorial } from './screens/Tutorial';
import { Puzzle } from './screens/Puzzle';
import { RatedHub, RatedSolve } from './screens/Rated';
import { Lobby } from './screens/Lobby';
import { Play } from './screens/Play';
import { Matching } from './screens/Matching';
import { OnlineGame } from './screens/OnlineGame';
import { Join } from './screens/Social';
import { Replay } from './screens/Records';
import { MyInfo } from './screens/MyInfo';
import { Rating } from './screens/Rating';
import { Settings } from './screens/Settings';
import { Splash, Start } from './screens/Onboarding';
import { setLang } from './i18n';
import { settings } from './lib/storage';
import { applySkin, applyTheme } from './lib/skins';

export type Route =
  | '' | 'me' | 'settings' | 'rating' | 'pvp' | 'match' | 'ai' | 'aigame' | 'local' | 'puzzle' | 'puzzles' | 'solve' | 'learn' | 'g' | 'join' | 'replay';
const ROUTES: Route[] = [
  '', 'me', 'settings', 'rating', 'pvp', 'match', 'ai', 'aigame', 'local', 'puzzle', 'puzzles', 'solve', 'learn', 'g', 'join', 'replay',
];
/** 예전 주소 → 지금 화면 */
const LEGACY: Record<string, Route> = { online: '', rank: '', records: 'me', play: 'ai' };

/** 화면 이동. replace 면 뒤로 가기 기록을 남기지 않는다 */
export type Go = (route: Route, param?: string, replace?: boolean) => void;

function readHash(): { route: Route; param: string } {
  const [raw = '', param = ''] = location.hash.replace(/^#\/?/, '').split('/');
  const name = LEGACY[raw] ?? raw;
  return ROUTES.includes(name as Route) ? { route: name as Route, param: decodeURIComponent(param) } : { route: '', param: '' };
}

export function applySettings() {
  const s = settings.get();
  setLang(s.lang);
  applySkin(s.skin);
  applyTheme(s.theme);
}

export function App() {
  const [{ route, param }, setLoc] = useState(readHash);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [gameId, setGameId] = useState(0);
  const [version, setVersion] = useState(0);
  const [splash, setSplash] = useState(true);
  const [onboarded, setOnboarded] = useState(() => !!settings.get().nickname);

  useEffect(() => {
    const timer = setTimeout(() => setSplash(false), 900);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onHash = () => setLoc(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route, param]);

  const go: Go = useCallback((r, p = '', replace = false) => {
    const hash = r ? `#/${r}${p ? `/${encodeURIComponent(p)}` : ''}` : '#';
    if (replace) history.replaceState(null, '', hash);
    else location.hash = hash.slice(1);
    setLoc({ route: r, param: p });
  }, []);

  const startAi = (c: GameConfig) => {
    setConfig(c);
    setGameId((n) => n + 1);
    go('aigame');
  };
  const review = (id: string) => go('replay', id);
  const rerender = () => {
    applySettings();
    setVersion((v) => v + 1);
  };
  const setup = <AiSetup onBack={() => go('')} onStart={(level, human) => startAi({ mode: 'ai', level, human })} />;

  let screen;
  if (!onboarded) screen = <Start onDone={() => setOnboarded(true)} />;
  else
    switch (route) {
      case 'ai':
        screen = setup;
        break;
      case 'aigame':
        screen =
          config?.mode === 'ai' ? (
            <GameScreen key={gameId} config={config} onHome={() => go('')} onReview={review} />
          ) : (
            setup
          );
        break;
      case 'local':
        screen = <GameScreen key="local" config={{ mode: 'local' }} onHome={() => go('')} onReview={review} />;
        break;
      case 'learn':
        screen = <Tutorial onHome={() => go('')} onPlayAi={() => startAi({ mode: 'ai', level: 'easy', human: 1 })} />;
        break;
      case 'puzzle':
        screen = <Puzzle onHome={() => go('')} onMore={() => go('puzzles')} />;
        break;
      case 'puzzles':
        screen = <RatedHub go={go} />;
        break;
      case 'solve':
        screen = <RatedSolve key={param} go={go} stage={param} />;
        break;
      case 'pvp':
        screen = <Play go={go} />;
        break;
      case 'match':
        screen = <Matching go={go} />;
        break;
      case 'g':
        screen = <OnlineGame key={param} id={param} go={go} />;
        break;
      case 'join':
        screen = <Join key={param} code={param} go={go} />;
        break;
      case 'replay':
        screen = <Replay key={param} id={param} go={go} />;
        break;
      case 'me':
        screen = <MyInfo go={go} route={route} />;
        break;
      case 'rating':
        screen = <Rating go={go} />;
        break;
      case 'settings':
        screen = <Settings go={go} route={route} onChange={rerender} />;
        break;
      default:
        screen = <Lobby go={go} route={route} onChange={rerender} />;
    }
  return (
    <>
      <div key={version} className="app">
        {screen}
      </div>
      {splash && <Splash />}
    </>
  );
}
