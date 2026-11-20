import type { Player } from '@gyeol/core';
import { t } from '../i18n';
import { settings, type SkinId, type ThemeSetting } from './storage';

/**
 * 타일 색 조합: [앞면, 화살표 윤곽 선] × 선공/후공. 모두 단색.
 * classic 은 MDF 타일 그대로(같은 갈색 면, 선공은 짙은 갈색 선 · 후공은 흰 선)이고 CSS 기본값을 쓴다.
 * 나머지는 면 색으로도 두 사람을 가른다 (색 구분이 어려울 때).
 */
export const SKINS: { id: SkinId; colors: [string, string, string, string] | null; preview: [string, string, string, string] }[] = [
  { id: 'classic', colors: null, preview: ['#9c6b43', '#3f2717', '#9c6b43', '#f3f1ec'] },
  { id: 'teal', colors: ['#2f6e6b', '#f3f1ec', '#c0573a', '#f3f1ec'], preview: ['#2f6e6b', '#f3f1ec', '#c0573a', '#f3f1ec'] }, // 딥 틸 · 테라코타
  { id: 'sea', colors: ['#4f9893', '#1f3f3c', '#d9735a', '#fbf1ea'], preview: ['#4f9893', '#1f3f3c', '#d9735a', '#fbf1ea'] }, // 시글라스 · 산호
  { id: 'vivid', colors: ['#2f6db5', '#f3f1ec', '#d9822b', '#3a2310'], preview: ['#2f6db5', '#f3f1ec', '#d9822b', '#3a2310'] }, // 파랑 · 주황
];

export function applySkin(id: SkinId = settings.get().skin) {
  const skin = SKINS.find((s) => s.id === id) ?? SKINS[0];
  const root = document.documentElement.style;
  const vars = ['--p1-face', '--p1-line', '--p2-face', '--p2-line'];
  vars.forEach((v, i) => (skin.colors ? root.setProperty(v, skin.colors[i]) : root.removeProperty(v)));
}

/** 화면 모드: 기기 설정 / 밝게 / 어둡게 */
export function applyTheme(theme: ThemeSetting = settings.get().theme) {
  const el = document.documentElement;
  if (theme === 'auto') delete el.dataset.theme;
  else el.dataset.theme = theme;
  // 주소창 색: 기기 설정이면 media 별로, 고정이면 둘 다 같은 색
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const darkMeta = m.getAttribute('media')?.includes('dark');
    const dark = theme === 'auto' ? darkMeta : theme === 'dark';
    m.setAttribute('content', dark ? '#1c1b1a' : '#f4efe7');
  });
}

/** 선공/후공 색 이름 (스킨에 따라 바뀜) */
export function sideName(p: Player): string {
  return t(`color.${settings.get().skin}.${p === 1 ? 'first' : 'second'}`);
}
