import { useEffect, useRef } from 'react';
import type { Position } from './track';

/** 안내와 직전 수의 애니메이션을 보여준 뒤 자동으로 패스한다. 국면이 바뀌면 취소한다. */
export function useAutoPass(pos: Position, enabled: boolean, onPass: () => void) {
  const callback = useRef(onPass);
  useEffect(() => { callback.current = onPass; }, [onPass]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => callback.current(), 650);
    return () => clearTimeout(timer);
  }, [pos, enabled]);
}
