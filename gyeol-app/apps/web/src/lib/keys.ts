import { useEffect, useRef } from 'react';

/** 단축키를 받아도 되는가: 이미 처리된 키가 아니고, 조합키 없이, 입력 칸 밖에서, 팝업이 닫혀 있을 때 */
export function shortcutAllowed(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return false;
  return !document.querySelector('.scrim');
}

/**
 * 화면 단축키. 키 이름은 KeyboardEvent.code (한글 입력 상태에서도 같은 자리의 키로 동작).
 * 값이 false·undefined 면 지금은 그 키를 쓰지 않는다 (버튼이 꺼진 상태와 맞춘다)
 */
export function useShortcuts(keys: Record<string, (() => void) | false | undefined>): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e)) return;
      const run = latest.current[e.code];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
