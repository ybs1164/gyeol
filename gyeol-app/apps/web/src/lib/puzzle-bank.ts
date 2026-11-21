import { useEffect, useSyncExternalStore } from 'react';
import { loadPuzzleBank, puzzleBankVersion, type PuzzleBankFile } from '@gyeol/core';
import { serverUrl } from './online';

/**
 * 퍼즐 은행은 서버가 만든다(GET /api/puzzles). 받은 은행은 이 기기에 저장해 두고,
 * 서버에 닿지 않을 때(비행기 모드 등)는 마지막으로 받은 은행으로 푼다.
 */
export type BankStatus = 'loading' | 'ready' | 'error';
const CACHE_KEY = 'gyeol:puzzle-bank';
let status: BankStatus = 'loading';
let fetching: Promise<void> | null = null;
let fetchedThisSession = false;
const listeners = new Set<() => void>();
const emit = (next: BankStatus) => { status = next; for (const l of listeners) l(); };

/** ws(s)://호스트/ws → http(s)://호스트/api/puzzles */
export function puzzleApiUrl(ws = serverUrl()): string {
  return ws.replace(/^ws/, 'http').replace(/\/ws$/, '') + '/api/puzzles';
}

function loadCached(): boolean {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    loadPuzzleBank(JSON.parse(raw) as PuzzleBankFile);
    return true;
  } catch {
    return false;
  }
}
if (loadCached()) status = 'ready';

/** 서버에서 새 은행을 받는다. 이미 받은 것과 같으면 브라우저 캐시 재검증(ETag)으로 끝난다. */
export function refreshPuzzleBank(): Promise<void> {
  fetching ??= (async () => {
    try {
      const res = await fetch(puzzleApiUrl(), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = (await res.json()) as PuzzleBankFile;
      if (file.version !== puzzleBankVersion()) {
        loadPuzzleBank(file);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(file)); } catch { /* 저장 공간 부족: 이번 실행에서만 사용 */ }
      }
      fetchedThisSession = true;
      emit('ready');
    } catch {
      emit(puzzleBankVersion() ? 'ready' : 'error');
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

/** 퍼즐 화면에서 쓴다. 저장된 은행이 있으면 바로 ready, 서버 확인은 뒤에서 한 번 한다. */
export function usePuzzleBank(): { status: BankStatus; retry: () => void } {
  const now = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => status);
  useEffect(() => { if (!fetchedThisSession) void refreshPuzzleBank(); }, []);
  return { status: now, retry: () => { emit('loading'); void refreshPuzzleBank(); } };
}
