import Database from 'better-sqlite3';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PASS, TIME_MODES, initial, apply, gameOver, isLegal, legal, replay,
  type ErrorCode, type Player, type TimeMode } from '@gyeol/core';
import { DEFAULT_RATING, update } from './glicko';
import { calibratedOpponent, effectiveRating, leaderboardEligible, ratingRestriction, REPEAT_WINDOW_MS } from './rating-policy';
import { initializeRatingRecord, type Data, type GameRecord, type PlayerRecord } from './models';

export type Change = { game?: GameRecord; players?: PlayerRecord[]; error?: ErrorCode; removed?: boolean };
type Row = Record<string, any>;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const newId = () => randomBytes(9).toString('base64url');
const columns = (value: Row) => Object.keys(value).join(',');

/** Runs exclusively in the DB worker. No network or AI awaits inside transactions. */
export class DatabaseEngine {
  readonly db: Database.Database;
  constructor(path: string, create = false) {
    this.db = new Database(path, { fileMustExist: path !== ':memory:' && !create, timeout: 1000 });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      if (this.db.pragma('foreign_keys', { simple: true }) !== 1 || this.db.pragma('synchronous', { simple: true }) !== 2) {
        throw new Error('Required SQLite settings are not active');
      }
      this.migrate();
    } catch (error) { this.db.close(); throw error; }
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
    const sql = readFileSync(fileURLToPath(new URL('./migrations/001.sql', import.meta.url)), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const checksum = hash(sql);
    const rows = this.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() as Row[];
    if (rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or modified database migration');
    if (!rows.length) this.db.transaction(() => {
      this.db.exec(sql);
      this.db.prepare('INSERT INTO schema_migrations VALUES (1,?,?)').run(checksum, Date.now());
    }).immediate();
  }

  private upsert(table: string, value: Row, key: string) {
    const names = Object.keys(value);
    this.db.prepare(`INSERT INTO ${table} (${columns(value)}) VALUES (${names.map(n => `@${n}`).join(',')})
      ON CONFLICT(${key}) DO UPDATE SET ${names.filter(n => n !== key).map(n => `${n}=excluded.${n}`).join(',')}`).run(value);
  }

  player(id: string, history = false): PlayerRecord | undefined {
    const r = this.db.prepare(`SELECT p.*,r.* FROM players p JOIN player_ratings r ON r.player_id=p.id WHERE p.id=?`).get(id) as Row | undefined;
    if (!r) return;
    return this.mapPlayer(r, history);
  }
  private mapPlayer(r: Row, history = false): PlayerRecord {
    return { id: r.id, token: '', name: r.name, rating: r.rating, rd: r.rd, vol: r.vol,
      ranked: r.ranked, rated: r.rated, wins: r.wins, losses: r.losses,
      createdAt: r.created_at, seenAt: r.seen_at, ratingAt: r.rating_at,
      ...(r.is_bot ? { bot: true } : {}), ...(r.bot_roster_version === null ? {} : { botRosterVersion: r.bot_roster_version }),
      ...(r.peak_rating === null ? {} : { peakRating: r.peak_rating }), ...(r.lowest_rating === null ? {} : { lowestRating: r.lowest_rating }),
      historyComplete: !!r.history_complete, ...(history ? { history: this.history(r.id) } : {}) };
  }

  history(id: string) {
    return this.db.prepare('SELECT at,rating FROM rating_events WHERE player_id=? AND visible=1 ORDER BY at,id').all(id) as { at: number; rating: number }[];
  }

  players(): PlayerRecord[] {
    return (this.db.prepare('SELECT p.*,r.* FROM players p JOIN player_ratings r ON r.player_id=p.id ORDER BY p.id').all() as Row[]).map(r => this.mapPlayer(r));
  }

  private writePlayer(p: PlayerRecord) {
    this.upsert('players', { id: p.id, name: p.name, is_bot: p.bot ? 1 : 0,
      bot_roster_version: p.botRosterVersion ?? null, created_at: p.createdAt, seen_at: p.seenAt }, 'id');
    this.upsert('player_ratings', { player_id: p.id, rating: p.rating, rd: p.rd, vol: p.vol,
      ranked: p.ranked, rated: p.rated ?? p.ranked, wins: p.wins, losses: p.losses,
      rating_at: p.ratingAt ?? p.createdAt, peak_rating: p.peakRating ?? null,
      lowest_rating: p.lowestRating ?? null, history_complete: p.historyComplete ? 1 : 0 }, 'player_id');
    if (p.token) this.db.prepare('INSERT INTO player_tokens(token_hash,player_id,created_at) VALUES (?,?,?)').run(hash(p.token), p.id, p.createdAt);
  }

  private legacyHistory(p: PlayerRecord) {
    const stmt = this.db.prepare(`INSERT INTO rating_events(player_id,source,legacy_index,at,rating,policy_version,visible)
      VALUES (?,'legacy',?,?,?,'legacy',1)`);
    for (const [index, point] of (p.history ?? []).entries()) stmt.run(p.id, index, point.at, point.rating);
  }

  /** Explicit fixture/import API; never exposed in the WebSocket protocol. */
  seedPlayer(p: PlayerRecord) {
    return this.db.transaction(() => {
      initializeRatingRecord(p);
      this.writePlayer(p); this.legacyHistory(p);
      return this.player(p.id, true)!;
    }).immediate();
  }

  patchPlayer(id: string, patch: Partial<PlayerRecord>) {
    return this.db.transaction(() => {
      const p = this.player(id)!;
      if (!p) throw new Error('Player not found');
      if (patch.id !== undefined || patch.token !== undefined) throw new Error('Identity patch is not allowed');
      Object.assign(p, patch);
      this.writePlayer(p);
      if (patch.history !== undefined) {
        this.db.prepare('DELETE FROM rating_events WHERE player_id=?').run(id);
        this.legacyHistory(p);
      }
      return this.player(id, true)!;
    }).immediate();
  }

  authenticate(token?: string): { player: PlayerRecord; token: string } {
    return this.db.transaction(() => {
      const row = token ? this.db.prepare('SELECT player_id FROM player_tokens WHERE token_hash=? AND revoked_at IS NULL').get(hash(token)) as Row | undefined : undefined;
      if (row) {
        const now = Date.now();
        this.db.prepare('UPDATE players SET seen_at=? WHERE id=?').run(now, row.player_id);
        this.db.prepare('UPDATE player_tokens SET last_used_at=? WHERE token_hash=?').run(now, hash(token!));
        return { player: this.player(row.player_id)!, token: token! };
      }
      const now = Date.now();
      const p: PlayerRecord = { id: newId(), token: randomBytes(24).toString('base64url'), name: `손님${randomInt(1000, 10000)}`,
        ...DEFAULT_RATING, ranked: 0, wins: 0, losses: 0, createdAt: now, seenAt: now };
      initializeRatingRecord(p); this.writePlayer(p);
      this.db.prepare(`INSERT INTO rating_events(player_id,source,at,rating,after_rating,policy_version,visible)
        VALUES (?,'baseline',?,1500,1500,'rating-v2',1)`).run(p.id, now);
      return { player: this.player(p.id)!, token: p.token };
    }).immediate();
  }

  tokenPlayer(token: string) {
    const row = this.db.prepare('SELECT player_id FROM player_tokens WHERE token_hash=? AND revoked_at IS NULL').get(hash(token)) as Row | undefined;
    return row ? this.player(row.player_id) : undefined;
  }

  syncBots(profiles: { id: string; name: string; rating: number; rd: number }[], rosterV2: boolean) {
    this.db.transaction(() => {
      for (const b of profiles) {
        const p = this.player(b.id) ?? { id: b.id, token: '', name: b.name, ...DEFAULT_RATING,
          ranked: 0, wins: 0, losses: 0, createdAt: Date.now(), seenAt: Date.now(), bot: true };
        initializeRatingRecord(p);
        Object.assign(p, { name: b.name, bot: true, rating: b.rating, rd: b.rd, vol: DEFAULT_RATING.vol });
        if (rosterV2 && p.botRosterVersion !== 2) Object.assign(p, { ranked: 0, wins: 0, losses: 0, botRosterVersion: 2 });
        this.writePlayer(p);
      }
    }).immediate();
    return profiles.map(p => this.player(p.id)!);
  }

  game(id: string): GameRecord | undefined {
    const r = this.db.prepare('SELECT * FROM games WHERE id=?').get(id) as Row | undefined;
    if (!r) return;
    const moves = this.db.prepare('SELECT action FROM game_moves WHERE game_id=? ORDER BY ply').all(id) as { action: number }[];
    return { id, code: r.code, ranked: !!r.ranked, mode: r.mode, greenId: r.green_id, brownId: r.brown_id,
      moves: moves.map(m => m.action), status: r.status, winner: r.winner, endReason: r.end_reason,
      turnLimitMs: r.turn_limit_ms, clock: r.clock_green === null ? null : { green: r.clock_green, brown: r.clock_brown },
      turnStartedAt: r.turn_started_at, createdAt: r.created_at, updatedAt: r.updated_at,
      ratingChange: r.rating_green === null ? null : { green: r.rating_green, brown: r.rating_brown },
      ...(r.restriction_green || r.restriction_brown ? { ratingRestriction: { ...(r.restriction_green ? { green: r.restriction_green } : {}), ...(r.restriction_brown ? { brown: r.restriction_brown } : {}) } } : {}),
      revision: r.revision, ruleVersion: r.rule_version, initialBoard: JSON.parse(r.initial_board_json), initialPlayer: r.initial_player };
  }

  private gamesBy(sql: string, ...args: (string | number)[]) {
    return (this.db.prepare(sql).all(...args) as { id: string }[]).map(r => this.game(r.id)!);
  }
  activeGames() { return this.gamesBy("SELECT id FROM games WHERE status='active'"); }
  playerGames(pid: string, limit = 30) {
    return this.gamesBy(`SELECT id,updated_at FROM (SELECT id,updated_at FROM games WHERE green_id=?
      UNION SELECT id,updated_at FROM games WHERE brown_id=?) ORDER BY updated_at DESC,id DESC LIMIT ?`, pid, pid, limit);
  }
  ongoingGames(pid: string) {
    return this.gamesBy("SELECT id FROM games WHERE (green_id=? OR brown_id=?) AND status!='finished'", pid, pid);
  }
  dueGames(now: number) { return this.gamesBy("SELECT id FROM games WHERE status='active' AND deadline_at<=?", now); }
  private pairGames(g: GameRecord, now: number) {
    const pair = [g.greenId!, g.brownId!].sort();
    return this.gamesBy("SELECT id FROM games WHERE pair_low=? AND pair_high=? AND ranked=1 AND status='finished' AND finished_at>=?", pair[0], pair[1], now - REPEAT_WINDOW_MS);
  }

  private writeGame(g: GameRecord, imported = false) {
    const old = this.game(g.id);
    const pair = g.greenId && g.brownId ? [g.greenId, g.brownId].sort() : [null, null];
    const left = timeLeft(g, g.turnStartedAt);
    this.upsert('games', { id: g.id, code: g.code, ranked: g.ranked ? 1 : 0, mode: g.mode ?? (g.ranked ? 'blitz' : 'daily'),
      green_id: g.greenId, brown_id: g.brownId, rule_version: g.ruleVersion ?? 'facing-25-v1',
      initial_board_json: JSON.stringify(g.initialBoard ?? initial()), initial_player: g.initialPlayer ?? 1,
      status: g.status, winner: g.winner, end_reason: g.endReason, turn_limit_ms: g.turnLimitMs,
      clock_green: g.clock?.green ?? null, clock_brown: g.clock?.brown ?? null,
      turn_started_at: g.turnStartedAt, created_at: g.createdAt, updated_at: g.updatedAt,
      finished_at: g.status === 'finished' ? g.updatedAt : null,
      time_source: imported && g.status === 'finished' ? 'legacy_updated_at' : null,
      deadline_at: g.status === 'active' && left !== null ? g.turnStartedAt + left : null,
      ply_count: g.moves.length, revision: (old?.revision ?? -1) + 1,
      rating_applied_at: g.status === 'finished' && g.ranked ? g.updatedAt : null,
      rating_green: g.ratingChange?.green ?? null, rating_brown: g.ratingChange?.brown ?? null,
      restriction_green: g.ratingRestriction?.green ?? null, restriction_brown: g.ratingRestriction?.brown ?? null,
      pair_low: pair[0], pair_high: pair[1] }, 'id');
    const prior = old?.moves ?? [];
    if (prior.some((a, i) => g.moves[i] !== a)) throw new Error('Existing moves cannot be rewritten');
    const insert = this.db.prepare('INSERT INTO game_moves VALUES (?,?,?,?,?)');
    for (let i = prior.length; i < g.moves.length; i++) insert.run(g.id, i + 1, g.moves[i], i % 2 ? -1 : 1, imported ? null : g.updatedAt);
  }

  seedGame(g: GameRecord) {
    return this.db.transaction(() => { validateMoves(g.moves); this.writeGame(g, true); return this.game(g.id)!; }).immediate();
  }
  patchGame(id: string, patch: Partial<GameRecord>) {
    return this.db.transaction(() => {
      const g = this.game(id); if (!g) throw new Error('Game not found');
      Object.assign(g, patch); validateMoves(g.moves); this.writeGame(g); return this.game(id)!;
    }).immediate();
  }

  createGame(greenId: string | null, brownId: string | null, ranked: boolean, mode: TimeMode, override?: number): GameRecord {
    return this.db.transaction(() => {
      const now = Date.now();
      const timing = TIME_MODES.find(m => m.id === mode)!;
      if (!timing) throw new Error('Unknown time mode');
      let code: string | null = null;
      if (!ranked) {
        do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); }
        while (this.db.prepare("SELECT 1 FROM games WHERE code=? AND status!='finished'").get(code));
      }
      const g: GameRecord = { id: newId(), code, ranked, mode, greenId, brownId, moves: [],
        status: greenId && brownId ? 'active' : 'waiting', winner: null, endReason: null,
        turnLimitMs: timing.turnMs === null ? null : override ?? timing.turnMs,
        clock: timing.clockMs === null ? null : { green: override ?? timing.clockMs, brown: override ?? timing.clockMs },
        turnStartedAt: now, createdAt: now, updatedAt: now, ratingChange: null };
      this.writeGame(g); return this.game(g.id)!;
    }).immediate();
  }

  joinGame(code: string, pid: string): Change {
    return this.db.transaction((): Change => {
      const row = this.db.prepare("SELECT id FROM games WHERE code=? AND status!='finished'").get(code) as Row | undefined;
      if (!row) return { error: 'not_found' };
      const g = this.game(row.id)!;
      if (colorOf(g, pid)) return { game: g };
      if (g.status !== 'waiting') return { error: 'full' };
      if (!g.greenId) g.greenId = pid; else g.brownId = pid;
      g.status = 'active'; g.turnStartedAt = g.updatedAt = Date.now(); this.writeGame(g);
      return { game: this.game(g.id) };
    }).immediate();
  }

  private settle(g: GameRecord, winner: Player | 0, reason: NonNullable<GameRecord['endReason']>, now: number): PlayerRecord[] {
    g.status = 'finished'; g.winner = winner; g.endReason = reason; g.updatedAt = now;
    if (!g.ranked) { this.writeGame(g); return []; }
    const green = this.player(g.greenId!)!, brown = this.player(g.brownId!)!;
    const before = [structuredClone(green), structuredClone(brown)];
    const s = winner === 1 ? 1 : winner === -1 ? 0 : 0.5;
    const common = ratingRestriction(g, this.pairGames(g, now), !green.bot && !brown.bot, now);
    const restrictions = [common ?? (!calibratedOpponent(brown) ? 'provisional' : undefined), common ?? (!calibratedOpponent(green) ? 'provisional' : undefined)] as const;
    const rg = effectiveRating(green, now), rb = effectiveRating(brown, now);
    const changes = [green.bot || (restrictions[0] && s >= .5) ? null : update(rg, rb, s),
      brown.bot || (restrictions[1] && 1 - s >= .5) ? null : update(rb, rg, 1 - s)];
    const people = [green, brown];
    g.ratingRestriction = restrictions.some(Boolean) ? { ...(restrictions[0] ? { green: restrictions[0] } : {}), ...(restrictions[1] ? { brown: restrictions[1] } : {}) } : undefined;
    g.ratingChange = { green: changes[0] ? Math.round(changes[0].rating) - Math.round(green.rating) : 0,
      brown: changes[1] ? Math.round(changes[1].rating) - Math.round(brown.rating) : 0 };
    this.writeGame(g);
    for (const [i, p] of people.entries()) {
      const changed = changes[i];
      if (changed) Object.assign(p, changed);
      if (!restrictions[i]) p.rated = (p.rated ?? 0) + 1;
      if (!p.bot && changed) {
        p.ratingAt = now;
        p.peakRating = Math.max(p.peakRating ?? Math.round(p.rating), Math.round(p.rating));
        p.lowestRating = Math.min(p.lowestRating ?? Math.round(p.rating), Math.round(p.rating));
      }
      p.ranked++;
      const score = i === 0 ? s : 1 - s;
      if (score === 1) p.wins++; if (score === 0) p.losses++;
      this.writePlayer(p);
      this.db.prepare(`INSERT INTO rating_events(player_id,game_id,source,at,rating,before_rating,after_rating,before_rd,after_rd,before_vol,after_vol,display_delta,restriction,policy_version,visible)
        VALUES (?,?,'game',?,?,?,?,?,?,?,?,?,?,'rating-v2',?)`).run(p.id, g.id, now, Math.round(p.rating), before[i].rating, p.rating,
          before[i].rd, p.rd, before[i].vol, p.vol, Math.round(p.rating) - Math.round(before[i].rating), restrictions[i] ?? null, !p.bot && changed ? 1 : 0);
    }
    return people;
  }

  applyMove(id: string, pid: string, ply: number, action: number, revision?: number): Change {
    return this.db.transaction((): Change => {
      const g = this.game(id); if (!g) return { error: 'not_found' };
      const color = colorOf(g, pid); if (!color) return { error: 'not_player' };
      if (g.status === 'finished') return { error: 'finished' };
      if (g.status !== 'active') return { error: 'not_your_turn' };
      if (ply !== g.moves.length || (revision !== undefined && revision !== g.revision)) return { error: 'stale' };
      const { board, player } = replay(g.moves);
      if (color !== player) return { error: 'not_your_turn' };
      if (!Number.isInteger(action) || !isLegal(board, player, action)) return { error: 'illegal' };
      const now = Date.now(), left = timeLeft(g, now); spend(g, now);
      let players: PlayerRecord[] = [];
      if (left !== null && left <= 0) players = this.settle(g, -color as Player, 'timeout', now);
      else {
        g.moves.push(action); forcedPass(g, now); g.turnStartedAt = g.updatedAt = now;
        const winner = gameOver(g.moves);
        if (winner !== null) players = this.settle(g, winner, 'normal', now);
        else this.writeGame(g);
      }
      return { game: this.game(id), players };
    }).immediate();
  }

  finishGame(id: string, pid: string | null, reason: 'resign' | 'timeout'): Change {
    return this.db.transaction((): Change => {
      const g = this.game(id); if (!g) return { error: 'not_found' };
      if (g.status === 'finished') return { error: 'finished' };
      const color = pid ? colorOf(g, pid) : 0;
      if (reason === 'resign' && !color) return { error: 'not_player' };
      if (g.status === 'waiting') {
        if (reason !== 'resign') return {};
        this.db.prepare('DELETE FROM games WHERE id=?').run(id); return { removed: true };
      }
      const now = Date.now(), left = timeLeft(g, now);
      if (reason === 'timeout' && (left === null || left > 0)) return {};
      spend(g, now);
      const loser = reason === 'timeout' ? replay(g.moves).player : color;
      const players = this.settle(g, -loser as Player, reason, now);
      return { game: this.game(id), players };
    }).immediate();
  }

  recover() {
    this.db.transaction(() => {
      for (const g of this.activeGames()) {
        const now = Date.now(), left = timeLeft(g, now);
        if (left !== null && left <= 0) { spend(g, now); this.settle(g, -replay(g.moves).player as Player, 'timeout', now); }
        else if (forcedPass(g, now)) this.writeGame(g);
      }
    }).immediate();
    return this.activeGames();
  }

  leaderboard() {
    const eligible: PlayerRecord[] = [], now = Date.now();
    const read = this.db.prepare(`SELECT p.*,r.* FROM player_ratings r INDEXED BY ratings_rank
      JOIN players p ON p.id=r.player_id ORDER BY r.rating DESC,r.player_id LIMIT 128 OFFSET ?`);
    // Apply time-dependent eligibility before the final 50-player limit.
    for (let offset = 0; ; offset += 128) {
      const rows = read.all(offset) as Row[];
      for (const row of rows) { const p = this.mapPlayer(row); if (leaderboardEligible(p,now)) eligible.push(p); if (eligible.length === 50) return eligible; }
      if (rows.length < 128) return eligible;
    }
  }
  health() {
    const players = (this.db.prepare('SELECT count(*) AS n FROM players').get() as Row).n as number;
    return { ok: true, storage: 'sqlite', players, sqlite: this.db.prepare('SELECT sqlite_version() AS version').get() };
  }
  integrity() { return { integrity: this.db.pragma('integrity_check') as Row[], foreignKeys: this.db.pragma('foreign_key_check') as Row[] }; }
  backup(path: string) { return this.db.backup(path); }
  close() { this.db.close(); }

  importData(data: Data, sourceHash: string) {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM import_runs WHERE source_sha256=?').get(sourceHash)) throw new Error('Source was already imported');
      if ((this.db.prepare('SELECT count(*) n FROM players').get() as Row).n || (this.db.prepare('SELECT count(*) n FROM games').get() as Row).n) throw new Error('Import requires an empty database');
      if (data.version !== 1 || !data.players || !data.games) throw new Error('Unsupported JSON structure');
      let history = 0, moves = 0;
      for (const [id, p] of Object.entries(data.players)) {
        if (id !== p.id || !p.token || ![p.rating, p.rd, p.vol, p.createdAt, p.seenAt].every(Number.isFinite)) throw new Error('Invalid legacy player');
        initializeRatingRecord(p); this.writePlayer(p); this.legacyHistory(p); history += p.history?.length ?? 0;
      }
      for (const [id, g] of Object.entries(data.games)) {
        if (id !== g.id) throw new Error('Invalid legacy game ID');
        validateMoves(g.moves);
        const winner = gameOver(g.moves);
        if (g.status === 'finished' && g.endReason === 'normal' && winner !== g.winner) throw new Error('Legacy result does not match moves');
        if (g.status === 'active' && winner !== null) throw new Error('Legacy active game is already terminal');
        this.writeGame(g, true); moves += g.moves.length;
      }
      const report = { players: Object.keys(data.players).length, games: Object.keys(data.games).length, history, moves };
      this.db.prepare('INSERT INTO import_runs VALUES (?,?,?,?,?)').run(sourceHash, Date.now(), report.players, report.games, JSON.stringify(report));
      return report;
    }).immediate();
  }

  snapshot(): Data {
    const players = Object.fromEntries(this.players().map(p => [p.id, this.player(p.id, true)!]));
    const games = Object.fromEntries(this.gamesBy('SELECT id FROM games ORDER BY id').map(g => [g.id, g]));
    return { version: 1, players, games };
  }
}

export function colorOf(g: GameRecord, pid: string): Player | 0 { return g.greenId === pid ? 1 : g.brownId === pid ? -1 : 0; }
export function timeLeft(g: GameRecord, now: number): number | null {
  if (g.clock) return g.clock[replay(g.moves).player === 1 ? 'green' : 'brown'] - (now - g.turnStartedAt);
  return g.turnLimitMs ? g.turnLimitMs - (now - g.turnStartedAt) : null;
}
function spend(g: GameRecord, now: number) {
  if (g.clock) { const side = replay(g.moves).player === 1 ? 'green' : 'brown'; g.clock[side] = Math.max(0, g.clock[side] - (now - g.turnStartedAt)); }
}
function forcedPass(g: GameRecord, now: number) {
  if (g.status !== 'active' || gameOver(g.moves) !== null) return false;
  const { board, player } = replay(g.moves);
  if (legal(board, player)[0] !== PASS) return false;
  g.moves.push(PASS); g.turnStartedAt = g.updatedAt = now; return true;
}
export function validateMoves(moves: number[]) {
  if (!Array.isArray(moves)) throw new Error('Invalid moves');
  let board = initial(), player: Player = 1;
  for (const action of moves) {
    if (!Number.isInteger(action) || !isLegal(board, player, action)) throw new Error('Illegal legacy move');
    board = apply(board, player, action).board; player = -player as Player;
  }
}
