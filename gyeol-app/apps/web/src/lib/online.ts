import { useSyncExternalStore } from 'react';
import type { ClientMsg, ErrorCode, OnlineGame, PublicPlayer, RatingPoint, RatingSummary, ServerMsg, TimeMode } from '@gyeol/core';
import { settings } from './storage';
import { isNative } from './platform';

export type Status = 'idle' | 'connecting' | 'online' | 'offline';
const NATIVE_SERVER = 'https://gyeol.146.56.189.166.sslip.io';

export interface OnlineState {
  status: Status;
  url: string;
  me: PublicPlayer | null;
  games: Record<string, OnlineGame>;
  /** 내 대국 목록 순서(최근 순) */
  list: string[];
  queued: boolean;
  queueSize: number;
  /** 매칭을 시작한 시각과 모드 */
  queuedAt: number;
  queueMode: TimeMode | null;
  /** 레이팅 기록 (내 정보 → 레이팅) */
  history: RatingPoint[] | null;
  ratingSummary: RatingSummary | null;
  /** 서버 시계 - 기기 시계 (ms) */
  skew: number;
  leaderboard: PublicPlayer[] | null;
  lastError: { code: ErrorCode; at: number } | null;
  /** 랭크전 매칭이 잡힌 대국 (화면 이동용, 한 번 읽으면 비움) */
  matched: string | null;
  /** 방금 만든 친구 방 (화면 이동용) */
  created: string | null;
}

/** 사용자가 적은 주소 → ws://호스트/ws.
 *  앱 안(안드로이드)은 기기 안의 웹 파일과 별도로 Oracle HTTPS 서버에 연결한다. */
export function serverUrl(input = settings.get().server): string {
  const raw = input.trim() || (import.meta.env.VITE_SERVER as string | undefined)?.trim() || (isNative() ? NATIVE_SERVER : '');
  if (!raw) {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  let u = raw.replace(/\/+$/, '');
  if (!/^[a-z]+:\/\//i.test(u)) u = `http://${u}`;
  const url = new URL(u);
  const proto = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss' : 'ws';
  return `${proto}://${url.host}/ws`;
}

/** 공개 웹 앱 주소(GitHub Pages, ybs1164.github.io 저장소의 gyeol/app). 게임 서버(WebSocket·퍼즐 API)는 NATIVE_SERVER 에 따로 있다. */
export const PUBLIC_WEB = 'https://ybs1164.github.io/gyeol/app';
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/;

/**
 * 초대·공유 링크에 쓸 웹 주소.
 * - 설정에서 서버를 직접 적었으면 그 서버(웹 앱도 함께 제공: 같은 와이파이 대국 등)
 * - 이 PC·같은 와이파이에서 연 웹이면 연 주소 그대로
 * - 그 밖(안드로이드 앱, 공개 웹)은 GitHub Pages
 */
export function webUrl(): string {
  if (settings.get().server.trim()) return (state.url || serverUrl()).replace(/^ws/, 'http').replace(/\/ws$/, '');
  if (!isNative() && PRIVATE_HOST.test(location.hostname)) return new URL(import.meta.env.BASE_URL, location.href).href.replace(/\/$/, '');
  return PUBLIC_WEB;
}

let state: OnlineState = {
  status: 'idle',
  url: '',
  me: null,
  games: {},
  list: [],
  queued: false,
  queueSize: 0,
  queuedAt: 0,
  queueMode: null,
  history: null,
  ratingSummary: null,
  skew: 0,
  leaderboard: null,
  lastError: null,
  matched: null,
  created: null,
};
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const outbox: ClientMsg[] = [];

function set(patch: Partial<OnlineState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const tokenKey = (url: string) => `gyeol:token:${url}`;

function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome': {
      const refreshHistory = state.history !== null;
      try {
        localStorage.setItem(tokenKey(state.url), msg.token);
      } catch {
        /* noop */
      }
      retry = 0;
      set({ status: 'online', me: msg.me, ...(state.me?.id !== msg.me.id ? { history: null, ratingSummary: null, games: {}, list: [], leaderboard: null } : {}) });
      while (outbox.length) ws!.send(JSON.stringify(outbox.shift()));
      if (refreshHistory) ws!.send(JSON.stringify({ t: 'history' }));
      syncName();
      return;
    }
    case 'me':
      if (state.history !== null && state.me?.ranked !== msg.me.ranked) ws?.send(JSON.stringify({ t: 'history' }));
      return set({ me: msg.me });
    case 'game': {
      const g = msg.game;
      const skew = typeof g.now === 'number' ? g.now - Date.now() : state.skew;
      const isNew = !state.games[g.id];
      const games = { ...state.games, [g.id]: g };
      const list = [g.id, ...state.list.filter((x) => x !== g.id)];
      const matched = isNew && g.ranked && state.queued ? g.id : state.matched;
      const created = isNew && g.status === 'waiting' ? g.id : state.created;
      return set({ games, list, matched, created, skew, queued: matched ? false : state.queued });
    }
    case 'games': {
      const games = { ...state.games };
      for (const g of msg.games) games[g.id] = g;
      return set({ games, list: msg.games.map((g) => g.id) });
    }
    case 'queued':
      return set({ queued: true, queueSize: msg.size, queueMode: msg.mode, queuedAt: state.queued ? state.queuedAt : Date.now() });
    case 'history':
      return set({ history: msg.points, ratingSummary: msg.summary ?? null });
    case 'unqueued':
      return set({ queued: false });
    case 'leaderboard':
      return set({ leaderboard: msg.players });
    case 'error':
      return set({ lastError: { code: msg.code, at: Date.now() } });
  }
}

/** 연결 (이미 연결돼 있으면 그대로). 주소가 바뀌면 다시 연결 */
export function connect() {
  const url = serverUrl();
  if (ws && state.url === url && (state.status === 'online' || state.status === 'connecting')) return;
  disconnect();
  if (!url) return set({ status: 'offline', url: '' });
  set({ status: 'connecting', url, ...(state.url !== url ? { me: null, games: {}, list: [], history: null, ratingSummary: null, leaderboard: null } : {}) });
  let token: string | undefined;
  try {
    token = localStorage.getItem(tokenKey(url)) ?? undefined;
  } catch {
    /* noop */
  }
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', token } satisfies ClientMsg));
  sock.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)));
    } catch {
      /* 잘못된 메시지 무시 */
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    set({ status: 'offline', queued: false });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(10_000, 1000 * 2 ** retry++));
  };
}

export function disconnect() {
  clearTimeout(retryTimer);
  const old = ws;
  ws = null;
  old?.close();
}

export function send(msg: ClientMsg) {
  if (ws && state.status === 'online') ws.send(JSON.stringify(msg));
  else {
    outbox.push(msg);
    connect();
  }
}

/** 시작 화면에서 정한 닉네임을 서버 이름과 맞춘다 */
export function syncName() {
  const nick = settings.get().nickname.trim();
  if (nick && state.me && state.me.name !== nick && ws && state.status === 'online') ws.send(JSON.stringify({ t: 'name', name: nick } satisfies ClientMsg));
}

/** 시간 모드로 매칭 시작 */
export function queue(mode: TimeMode) {
  set({ queued: true, queueMode: mode, queuedAt: Date.now(), queueSize: 0 });
  send({ t: 'queue', mode });
}

export function unqueue() {
  set({ queued: false, queueMode: null });
  send({ t: 'unqueue' });
}

export function takeMatched(): string | null {
  const m = state.matched;
  if (m) state = { ...state, matched: null };
  return m;
}

export function takeCreated(): string | null {
  const c = state.created;
  if (c) state = { ...state, created: null };
  return c;
}

export function useOnline(): OnlineState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** 대국 정보 갱신을 서버에 반영 (낙관적 갱신이 거부됐을 때) */
export function patchGame(g: OnlineGame) {
  set({ games: { ...state.games, [g.id]: g } });
}
