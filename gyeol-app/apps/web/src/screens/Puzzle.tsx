import { useMemo } from 'react';
import { dateKey } from '@gyeol/core';
import { RatedSolve } from './Rated';

/** 오늘의 퍼즐도 동일하게 종국 승리가 검증된 실전 기보를 사용한다. */
export function Puzzle({ onHome, onMore }: { onHome: () => void; onMore: () => void }) {
  const key = useMemo(() => dateKey(), []);
  return <RatedSolve go={(route) => route === 'puzzles' ? onMore() : onHome()} stage="" daily={{ key, onHome, onMore }} />;
}
