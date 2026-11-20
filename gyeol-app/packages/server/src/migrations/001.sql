CREATE TABLE players (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_bot INTEGER NOT NULL CHECK(is_bot IN (0,1)),
  bot_roster_version INTEGER, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE player_tokens (
  token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
) STRICT;
CREATE INDEX tokens_player ON player_tokens(player_id);
CREATE TABLE player_ratings (
  player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE RESTRICT,
  rating REAL NOT NULL, rd REAL NOT NULL CHECK(rd > 0 AND rd <= 350), vol REAL NOT NULL CHECK(vol > 0),
  ranked INTEGER NOT NULL CHECK(ranked >= 0), rated INTEGER NOT NULL CHECK(rated >= 0),
  wins INTEGER NOT NULL CHECK(wins >= 0), losses INTEGER NOT NULL CHECK(losses >= 0),
  rating_at INTEGER NOT NULL, peak_rating REAL, lowest_rating REAL,
  history_complete INTEGER NOT NULL CHECK(history_complete IN (0,1))
) STRICT;
CREATE INDEX ratings_rank ON player_ratings(rating DESC, player_id);
CREATE TABLE games (
  id TEXT PRIMARY KEY, code TEXT, ranked INTEGER NOT NULL CHECK(ranked IN (0,1)),
  mode TEXT NOT NULL CHECK(mode IN ('bullet','blitz','rapid','daily')),
  green_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  brown_id TEXT REFERENCES players(id) ON DELETE RESTRICT,
  rule_version TEXT NOT NULL CHECK(rule_version = 'facing-25-v1'), initial_board_json TEXT NOT NULL,
  initial_player INTEGER NOT NULL CHECK(initial_player IN (1,-1)),
  status TEXT NOT NULL CHECK(status IN ('waiting','active','finished')),
  winner INTEGER CHECK(winner IN (-1,0,1)), end_reason TEXT CHECK(end_reason IN ('normal','resign','timeout')),
  turn_limit_ms INTEGER CHECK(turn_limit_ms > 0), clock_green INTEGER CHECK(clock_green >= 0), clock_brown INTEGER CHECK(clock_brown >= 0),
  turn_started_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  finished_at INTEGER, time_source TEXT, deadline_at INTEGER,
  ply_count INTEGER NOT NULL CHECK(ply_count >= 0), revision INTEGER NOT NULL CHECK(revision >= 0),
  rating_applied_at INTEGER, rating_green INTEGER, rating_brown INTEGER,
  restriction_green TEXT CHECK(restriction_green IN ('early','repeat','provisional')),
  restriction_brown TEXT CHECK(restriction_brown IN ('early','repeat','provisional')),
  pair_low TEXT, pair_high TEXT,
  CHECK(green_id IS NULL OR brown_id IS NULL OR green_id != brown_id),
  CHECK(status = 'waiting' OR (green_id IS NOT NULL AND brown_id IS NOT NULL)),
  CHECK((status = 'finished' AND winner IS NOT NULL AND end_reason IS NOT NULL AND finished_at IS NOT NULL)
     OR (status != 'finished' AND winner IS NULL AND end_reason IS NULL AND finished_at IS NULL)),
  CHECK((clock_green IS NULL) = (clock_brown IS NULL))
) STRICT;
CREATE UNIQUE INDEX games_live_code ON games(code) WHERE code IS NOT NULL AND status != 'finished';
CREATE INDEX games_green_recent ON games(green_id, updated_at DESC, id DESC);
CREATE INDEX games_brown_recent ON games(brown_id, updated_at DESC, id DESC);
CREATE INDEX games_pair_finished ON games(pair_low, pair_high, finished_at) WHERE ranked = 1 AND status = 'finished';
CREATE INDEX games_deadline ON games(deadline_at) WHERE status = 'active';
CREATE TABLE game_moves (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, ply INTEGER NOT NULL CHECK(ply >= 1),
  action INTEGER NOT NULL CHECK(action BETWEEN 0 AND 784), side INTEGER NOT NULL CHECK(side IN (-1,1)),
  recorded_at INTEGER, PRIMARY KEY(game_id,ply)
) STRICT;
CREATE TABLE rating_events (
  id INTEGER PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  game_id TEXT REFERENCES games(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('baseline','legacy','game')), legacy_index INTEGER,
  at INTEGER NOT NULL, rating REAL NOT NULL, before_rating REAL, after_rating REAL,
  before_rd REAL, after_rd REAL, before_vol REAL, after_vol REAL, display_delta INTEGER,
  restriction TEXT CHECK(restriction IN ('early','repeat','provisional')),
  policy_version TEXT NOT NULL, visible INTEGER NOT NULL CHECK(visible IN (0,1)),
  UNIQUE(game_id,player_id), UNIQUE(player_id,legacy_index)
) STRICT;
CREATE INDEX events_history ON rating_events(player_id, at, id);
CREATE TABLE import_runs (
  source_sha256 TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, players INTEGER NOT NULL,
  games INTEGER NOT NULL, report_json TEXT NOT NULL
) STRICT;
