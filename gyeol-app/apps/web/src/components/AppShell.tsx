import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { useLayout } from '../lib/layout';
import { t } from '../i18n';
import type { Go, Route } from '../App';

const base = import.meta.env.BASE_URL;

type TabIcon = 'me' | 'lobby' | 'settings';
const tabItems = (): { r: Route; icon: TabIcon; label: string }[] => [
  { r: 'me', icon: 'me', label: t('tab.me') },
  { r: '', icon: 'lobby', label: t('tab.lobby') },
  { r: 'settings', icon: 'settings', label: t('tab.settings') },
];

/** 탭 이동은 뒤로 가기 기록을 남기지 않는다 */
const switchTab = (go: Go, from: Route, to: Route) => from !== to && go(to, '', true);

function PlayButton({ go }: { go: Go }) {
  return (
    <button className="btn primary play" onClick={() => go('pvp')}>
      {t('lobby.play')}
    </button>
  );
}

/** 하단 탭: 내 정보 · 로비 · 설정 */
export function TabBar({ route, go }: { route: Route; go: Go }) {
  return (
    <nav className="tabbar">
      {tabItems().map((x) => (
        <button key={x.icon} aria-current={route === x.r ? 'page' : undefined} onClick={() => switchTab(go, route, x.r)}>
          <Icon name={x.icon} />
          {x.label}
        </button>
      ))}
    </nav>
  );
}

/** 넓은 창의 왼쪽 레일: 로고 · 대국하기 · 로비 · 내 정보 · 설정 */
export function NavRail({ route, go }: { route: Route; go: Go }) {
  const items = tabItems();
  // 세로로 놓을 때는 로비를 맨 위에
  const ordered = [items[1], items[0], items[2]];
  return (
    <aside className="rail">
      <div className="brand">
        <img className="brand-mark" src={`${base}tiles/front.svg`} alt="" />
        <b>결</b>
      </div>
      <PlayButton go={go} />
      <nav>
        {ordered.map((x) => (
          <button key={x.icon} aria-current={route === x.r ? 'page' : undefined} onClick={() => switchTab(go, route, x.r)}>
            <Icon name={x.icon} />
            {x.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}

/** 넓은 창에서만 두 열로 나눈다. 좁음·중간에서는 왼쪽 다음 오른쪽 순서로 그대로 이어 그린다 */
export function TwoColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  const layout = useLayout();
  if (layout !== 'expanded')
    return (
      <>
        {left}
        {right}
      </>
    );
  return (
    <div className="cols">
      <div className="col">{left}</div>
      <div className="col">{right}</div>
    </div>
  );
}

interface ShellProps {
  route: Route;
  go: Go;
  /** 좁은 화면에서 탭 바 위에 대국하기 버튼을 둘지 (로비만). 레일에는 항상 있다 */
  play?: boolean;
  /** 넓은 창에서 내용 폭: wide 1040px (두 열), narrow 640px (설정처럼 한 줄 목록), 기본 720px */
  width?: 'wide' | 'narrow';
  children: ReactNode;
}

/**
 * 탭 화면(로비 · 내 정보 · 설정)의 틀.
 * 좁음·중간: 화면 + 아래 고정 영역(대국하기 · 탭 바). 넓음: 왼쪽 레일 + 가운데 내용.
 */
export function AppShell({ route, go, play = false, width, children }: ShellProps) {
  const layout = useLayout();

  if (layout === 'expanded')
    return (
      <div className="shell">
        <NavRail route={route} go={go} />
        <div className={`screen shell-main${width ? ` ${width}` : ''}`}>{children}</div>
      </div>
    );

  return (
    <div className="screen docked">
      {children}
      <div className="dock">
        {play && (
          <div className="cta">
            <PlayButton go={go} />
          </div>
        )}
        <TabBar route={route} go={go} />
      </div>
    </div>
  );
}
