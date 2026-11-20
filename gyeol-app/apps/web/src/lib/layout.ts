import { useSyncExternalStore } from 'react';

/**
 * 창 크기 단계. 기기 종류가 아니라 지금 창의 크기로 고른다.
 * - compact: 폭 600px 미만 (휴대폰, 지금 화면 그대로)
 * - medium: 폭 600px 이상, 또는 넓지만 높이가 640px 미만
 * - expanded: 폭 1024px 이상이고 높이 640px 이상
 */
export type Layout = 'compact' | 'medium' | 'expanded';

const QUERIES = {
  expanded: '(min-width: 1024px) and (min-height: 640px)',
  medium: '(min-width: 600px)',
} as const;

const canMatch = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
const expandedMq = canMatch ? window.matchMedia(QUERIES.expanded) : null;
const mediumMq = canMatch ? window.matchMedia(QUERIES.medium) : null;

export function currentLayout(): Layout {
  if (expandedMq?.matches) return 'expanded';
  if (mediumMq?.matches) return 'medium';
  return 'compact';
}

function subscribe(onChange: () => void): () => void {
  expandedMq?.addEventListener('change', onChange);
  mediumMq?.addEventListener('change', onChange);
  return () => {
    expandedMq?.removeEventListener('change', onChange);
    mediumMq?.removeEventListener('change', onChange);
  };
}

/** 지금 창 크기 단계. 창 크기가 바뀌면 다시 그린다 */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, currentLayout, () => 'compact');
}

/** <html data-layout="…"> 를 창 크기에 맞춰 유지한다. CSS 가 같은 기준을 쓰게 하려고 */
export function setupLayout(): void {
  if (!canMatch) return;
  const apply = () => {
    document.documentElement.dataset.layout = currentLayout();
  };
  apply();
  subscribe(apply);
}
