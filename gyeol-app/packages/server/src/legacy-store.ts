import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EndReason, GameStatus, Player, RatingPoint, RatingRestriction, TimeMode } from '@gyeol/core';
import type { Rating } from './glicko';

export interface PlayerRecord extends Rating {
  id: string;
  token: string;
  name: string;
  ranked: number;
  rated?: number;
  wins: number;
  losses: number;
  createdAt: number;
  seenAt: number;
  /** AI 플레이어 (레이팅 고정, packages/ai/src/persona.ts) */
  bot?: boolean;
  /** 기준점 대전 전적과 실제 사람 상대 전적을 분리한 버전 */
  botRosterVersion?: number;
  /** 마지막으로 RD를 계산한 시각. 로그인만으로 바꾸지 않는다 */
  ratingAt?: number;
  peakRating?: number;
  lowestRating?: number;
  historyComplete?: boolean;
  /** 과거 300개 제한 이후부터는 모든 레이팅 변화를 보존한다 */
  history?: RatingPoint[];
}

export interface GameRecord {
  id: string;
  code: string | null;
  ranked: boolean;
  /** 예전 저장 파일에는 없음 */
  mode?: TimeMode;
  greenId: string | null;
  brownId: string | null;
  moves: number[];
  status: GameStatus;
  winner: Player | 0 | null;
  endReason: EndReason | null;
  turnLimitMs: number | null;
  clock?: { green: number; brown: number } | null;
  turnStartedAt: number;
  createdAt: number;
  updatedAt: number;
  ratingChange: { green: number; brown: number } | null;
  ratingRestriction?: { green?: RatingRestriction; brown?: RatingRestriction };
}

interface Data {
  version: 1;
  players: Record<string, PlayerRecord>;
  games: Record<string, GameRecord>;
}

/**
 * JSON 파일 저장소. 변경 후 0.5초 모아서 임시 파일에 쓰고 이름을 바꿔(원자적 교체) 저장한다.
 * 소규모(수천 명) 운영용. 규모가 커지면 같은 인터페이스로 DB를 붙이면 된다.
 */
export class Store {
  data: Data = { version: 1, players: {}, games: {} };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private byToken = new Map<string, string>();

  constructor(private file: string | null) {
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8'));
    if (file && existsSync(file) && Object.values(this.data.players).some((p) => p.rated === undefined || p.ratingAt === undefined)) {
      const backup = `${file}.before-rating-v2.bak`;
      if (!existsSync(backup)) copyFileSync(file, backup, constants.COPYFILE_EXCL);
    }
    for (const p of Object.values(this.data.players)) {
      this.byToken.set(p.token, p.id);
      initializeRatingRecord(p);
    }
  }

  playerByToken(token: string): PlayerRecord | undefined {
    const id = this.byToken.get(token);
    return id ? this.data.players[id] : undefined;
  }

  addPlayer(p: PlayerRecord) {
    initializeRatingRecord(p);
    this.data.players[p.id] = p;
    this.byToken.set(p.token, p.id);
    this.save();
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}

/** 이미 삭제된 이력은 추측해서 복원하지 않는다. 기존 계정·점수·전적은 유지한다. */
export function initializeRatingRecord(p: PlayerRecord) {
  p.rated ??= p.ranked;
  p.historyComplete ??= (p.history?.length ?? 0) === p.ranked;
  p.ratingAt ??= p.history?.at(-1)?.at ?? p.createdAt;
  if (p.bot) return;
  p.history ??= [];
  if (p.historyComplete && (p.history[0]?.at ?? Infinity) > p.createdAt) {
    p.history.unshift({ at: p.createdAt, rating: 1500 });
  }
  p.peakRating ??= p.history.reduce((peak, h) => Math.max(peak, h.rating), Math.round(p.rating));
  p.lowestRating ??= p.history.reduce((lowest, h) => Math.min(lowest, h.rating), Math.round(p.rating));
}
