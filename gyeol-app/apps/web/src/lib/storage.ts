import type { Level } from '@gyeol/ai';
import { PUZZLE_BANK_VERSION, PUZZLE_SCALE, PUZZLE_START, migratePuzzleRating, puzzleStartForGame, type Player, type TimeMode } from '@gyeol/core';

/** 이 기기에만 저장되는 기록. 저장소가 막혀 있어도 앱은 동작해야 한다. */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`gyeol:${key}`);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return Array.isArray(fallback) ? v : { ...fallback, ...v };
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(`gyeol:${key}`, JSON.stringify(value));
  } catch {
    /* 저장 불가 — 무시 */
  }
}

export type LangSetting = 'auto' | 'ko' | 'en' | 'ja' | 'zh';
export type SkinId = 'classic' | 'teal' | 'sea' | 'vivid';
export type ThemeSetting = 'auto' | 'light' | 'dark';

export interface Settings {
  sound: boolean;
  tutorialDone: boolean;
  level: Level;
  color: 'green' | 'brown' | 'random';
  lang: LangSetting;
  skin: SkinId;
  /** 온라인 서버 주소. 비어 있으면 빌드 기본값(VITE_SERVER) → 앱을 연 주소와 같은 서버 */
  server: string;
  /** 시작 화면에서 정한 닉네임. 비어 있으면 아직 온보딩 전 */
  nickname: string;
  vibrate: boolean;
  theme: ThemeSetting;
  /** 플레이 화면에서 마지막으로 고른 시간 모드 */
  timeMode: TimeMode;
  coordinates: boolean;
}

const DEFAULTS: Settings = {
  sound: true,
  tutorialDone: false,
  level: 'easy',
  color: 'green',
  lang: 'auto',
  skin: 'classic',
  server: '',
  nickname: '',
  vibrate: true,
  theme: 'auto',
  timeMode: 'blitz',
  coordinates: false,
};

export const settings = {
  get: () => read<Settings>('settings', DEFAULTS),
  set: (patch: Partial<Settings>) => write('settings', { ...settings.get(), ...patch }),
};

type Record3 = { win: number; loss: number; draw: number };
export type AiStats = Record<Level, Record3>;

const emptyStats = (): AiStats => ({
  easy: { win: 0, loss: 0, draw: 0 },
  normal: { win: 0, loss: 0, draw: 0 },
  hard: { win: 0, loss: 0, draw: 0 },
  master: { win: 0, loss: 0, draw: 0 },
});

export const aiStats = {
  get: () => read<AiStats>('ai-stats', emptyStats()),
  add: (level: Level, outcome: keyof Record3) => {
    const s = aiStats.get();
    s[level] = { ...s[level], [outcome]: s[level][outcome] + 1 };
    write('ai-stats', s);
  },
};

export interface PuzzleDay {
  /** 새 실전 퍼즐: 실패 0, 승리 1. 이전 장수 목표 기록은 별도 보존한다. */
  attempts: number[];
  solved: boolean;
  puzzleId?: string;
}

export const puzzleLog = {
  all: (): Record<string, PuzzleDay> => {
    const legacy = read<Record<string, PuzzleDay>>('puzzles', {});
    const current = read<Record<string, PuzzleDay>>('record-daily-puzzles', {});
    const combined = { ...legacy };
    for (const [key, day] of Object.entries(current)) combined[key] = { ...day, solved: day.solved || !!legacy[key]?.solved };
    return combined;
  },
  get: (key: string): PuzzleDay => read<Record<string, PuzzleDay>>('record-daily-puzzles', {})[key] ?? { attempts: [], solved: false },
  set: (key: string, day: PuzzleDay) => write('record-daily-puzzles', { ...read<Record<string, PuzzleDay>>('record-daily-puzzles', {}), [key]: day }),
};

/** 레이팅 퍼즐 기록. 이 기기에만 저장 */
export interface PuzzleRating {
  scaleVersion: number;
  bankVersion: number;
  seededFromGame: boolean;
  retiredCurrent?: string;
  rating: number;
  /** 레이팅이 걸린 풀이 수(첫 시도만 셈) */
  played: number;
  solved: number;
  /** 지금 연속 정답 */
  streak: number;
  bestStreak: number;
  peak: number;
  /** 최근 레이팅 (그래프용, 최근 60개) */
  history: number[];
  /** 이미 푼 퍼즐 id (같은 퍼즐이 다시 나오지 않게) */
  seen: string[];
  /** 풀던 퍼즐 — 화면을 나갔다 와도 같은 퍼즐 */
  current: string | null;
}

const PUZZLE_RATING: PuzzleRating = {
  scaleVersion: PUZZLE_SCALE.version,
  bankVersion: PUZZLE_BANK_VERSION,
  seededFromGame: false,
  rating: PUZZLE_START,
  played: 0,
  solved: 0,
  streak: 0,
  bestStreak: 0,
  peak: PUZZLE_START,
  history: [],
  seen: [],
  current: null,
};

function getPuzzleRating(): PuzzleRating {
  const saved = read<Partial<PuzzleRating>>('puzzle-rating', {});
  let rec = { ...PUZZLE_RATING, ...saved };
  if (!Object.keys(saved).length) return rec;
  let changed = false;
  if (saved.scaleVersion !== PUZZLE_SCALE.version) {
    if (!Object.keys(read<Record<string, unknown>>('puzzle-rating-v1-backup', {})).length) write('puzzle-rating-v1-backup', saved);
    const played = rec.played > 0;
    rec = { ...rec, scaleVersion: PUZZLE_SCALE.version,
      rating: played ? migratePuzzleRating(rec.rating) : PUZZLE_START,
      peak: played ? migratePuzzleRating(rec.peak) : PUZZLE_START,
      history: played ? rec.history.map(migratePuzzleRating) : [] };
    changed = true;
  }
  if (saved.bankVersion !== PUZZLE_BANK_VERSION || (rec.current && !rec.current.startsWith('rp-'))) {
    if (!Object.keys(read<Record<string, unknown>>('puzzle-rating-v2-bank-backup', {})).length) write('puzzle-rating-v2-bank-backup', saved);
    rec = { ...rec, bankVersion: PUZZLE_BANK_VERSION, ...(rec.current && !rec.current.startsWith('rp-') ? { retiredCurrent: rec.current, current: null } : {}) };
    changed = true;
  }
  if (changed) write('puzzle-rating', rec);
  return rec;
}

export const puzzleRating = {
  get: getPuzzleRating,
  /** 첫 시작 때만 대국 실력을 참고하고 풀던 문제와 기존 성적은 덮어쓰지 않는다. */
  seedFromGame: (rating?: number, ranked = 0): PuzzleRating => {
    const rec = getPuzzleRating();
    if (rec.played || rec.current || rec.seededFromGame || ranked < 5 || rating === undefined || !Number.isFinite(rating)) return rec;
    const start = puzzleStartForGame(rating, ranked);
    const next = { ...rec, rating: start, peak: start, history: [], seededFromGame: true };
    write('puzzle-rating', next);
    return next;
  },
  set: (patch: Partial<PuzzleRating>) => write('puzzle-rating', { ...puzzleRating.get(), ...patch }),
  /** 첫 시도 결과를 반영하고 새 기록을 돌려준다 */
  record: (id: string, solved: boolean, delta: number): PuzzleRating => {
    const r = puzzleRating.get();
    if (r.seen.includes(id)) {
      const next = { ...r, current: null };
      write('puzzle-rating', next);
      return next;
    }
    const rating = Math.max(100, r.rating + delta);
    const streak = solved ? r.streak + 1 : 0;
    const next: PuzzleRating = {
      ...r,
      rating,
      played: r.played + 1,
      solved: r.solved + (solved ? 1 : 0),
      streak,
      bestStreak: Math.max(r.bestStreak, streak),
      peak: Math.max(r.peak, rating),
      history: [...(r.history.length ? r.history : [r.rating]), rating].slice(-60),
      seen: r.seen.includes(id) ? r.seen : [...r.seen, id],
      current: null,
    };
    write('puzzle-rating', next);
    return next;
  },
};

/** 끝난 대국 기록 (복기용). 최근 100판만 보관 */
export interface GameRecord {
  id: string;
  mode: 'ai' | 'local' | 'online';
  date: number;
  moves: number[];
  /** 과거 기보는 facing-25-v1 초기 국면으로 복원한다. */
  initialBoard?: number[];
  initialPlayer?: Player;
  ruleVersion?: 'facing-25-v1';
  winner: Player | 0;
  /** 이 기기 사용자의 색 (둘이서는 null) */
  me: Player | null;
  level?: Level;
  ranked?: boolean;
  /** 온라인 상대 이름 */
  opponent?: string;
  /** 온라인 상대 레이팅·랭크 판수 (티어 표시용) */
  oppRating?: number;
  oppRanked?: number;
  oppBot?: boolean;
  /** 온라인 시간 모드 */
  timeMode?: TimeMode;
  /** 끝난 뒤 판의 타일 수 (기록 목록용) */
  score?: { me: number; opp: number };
  endReason?: 'normal' | 'resign' | 'timeout';
  ratingChange?: number;
}

const MAX_RECORDS = 100;

export const records = {
  all: () => read<GameRecord[]>('records', []),
  get: (id: string) => records.all().find((r) => r.id === id),
  add: (r: GameRecord) => {
    const list = records.all().filter((x) => x.id !== r.id);
    write('records', [r, ...list].slice(0, MAX_RECORDS));
  },
  clear: () => write('records', []),
};

/** 복기에서 계산한 내 정확도. 판 사이의 변화를 보여주는 데만 쓴다. */
export interface AccuracyEntry { id: string; date: number; accuracy: number }
export const accuracyLog = {
  all: () => read<AccuracyEntry[]>('accuracy', []),
  put: (entry: AccuracyEntry) => {
    const list = accuracyLog.all().filter((x) => x.id !== entry.id);
    write('accuracy', [entry, ...list].sort((a, b) => b.date - a.date).slice(0, MAX_RECORDS));
  },
};

export const newRecordId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
