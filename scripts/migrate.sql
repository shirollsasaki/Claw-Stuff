-- Claw-Stuff Database Migration
-- Run this in Railway Postgres console if you can't run `npm run migrate`

BEGIN;

-- Agents table: one row per Moltbook agent / API key
CREATE TABLE IF NOT EXISTS agents (
  id       SERIAL PRIMARY KEY,
  name     TEXT UNIQUE NOT NULL,
  api_key  TEXT UNIQUE NOT NULL
);

-- Matches table: one row per match
CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  winner_name  TEXT,
  ended_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match players table: per-agent stats for each match
CREATE TABLE IF NOT EXISTS match_players (
  match_id    TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   TEXT,
  agent_name  TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  color       TEXT,
  score       INTEGER NOT NULL DEFAULT 0,
  kills       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, agent_name)
);

-- Add skin_id column to match_players
ALTER TABLE match_players
  ADD COLUMN IF NOT EXISTS skin_id TEXT;

-- Agent skins table: tracks which skins each agent owns
CREATE TABLE IF NOT EXISTS agent_skins (
  agent_name  TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  skin_id     TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_name, skin_id)
);

-- Grant the default skin to all existing agents that don't have it yet
INSERT INTO agent_skins (agent_name, skin_id)
SELECT a.name, 'default'
FROM agents a
LEFT JOIN agent_skins s
  ON s.agent_name = a.name
 AND s.skin_id = 'default'
WHERE s.agent_name IS NULL
ON CONFLICT DO NOTHING;

-- Betting: wallet_address on agents
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS wallet_address TEXT;

-- Betting pools: one row per match that has betting
CREATE TABLE IF NOT EXISTS betting_pools (
  match_id           TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  total_pool         NUMERIC(78,0) NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  agent_names        TEXT[],
  winner_agent_names TEXT[],
  winner_agent_wallets TEXT[],
  is_draw            BOOLEAN NOT NULL DEFAULT FALSE,
  treasury_payout    NUMERIC(78,0) NOT NULL DEFAULT 0,
  agent_payout       NUMERIC(78,0) NOT NULL DEFAULT 0,
  resolve_tx_hash    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ
);

-- Add agent_names column if table already exists
ALTER TABLE betting_pools
  ADD COLUMN IF NOT EXISTS agent_names TEXT[];

-- Individual bets (multiple per user per match allowed)
CREATE TABLE IF NOT EXISTS bets (
  id              SERIAL PRIMARY KEY,
  match_id        TEXT NOT NULL REFERENCES betting_pools(match_id) ON DELETE CASCADE,
  bettor_address  TEXT NOT NULL,
  bettor_type     TEXT NOT NULL,
  bettor_name     TEXT,
  agent_name      TEXT NOT NULL,
  amount          NUMERIC(78,0) NOT NULL,
  tx_hash         TEXT,
  placed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Token column for bets (MON vs MCLAW)
ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'MON';

-- Bet settlements (payout records)
CREATE TABLE IF NOT EXISTS bet_settlements (
  id              SERIAL PRIMARY KEY,
  match_id        TEXT NOT NULL REFERENCES betting_pools(match_id) ON DELETE CASCADE,
  bettor_address  TEXT NOT NULL,
  payout_amount   NUMERIC(78,0) NOT NULL,
  claim_tx_hash   TEXT,
  settled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Token column for settlements
ALTER TABLE bet_settlements
  ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'MON';

-- Betting leaderboard (aggregated stats per bettor, per token)
CREATE TABLE IF NOT EXISTS betting_leaderboard (
  bettor_address  TEXT NOT NULL,
  token           TEXT NOT NULL DEFAULT 'MON',
  bettor_name     TEXT,
  total_volume    NUMERIC(78,0) NOT NULL DEFAULT 0,
  total_bets      INTEGER NOT NULL DEFAULT 0,
  total_wins      INTEGER NOT NULL DEFAULT 0,
  total_payout    NUMERIC(78,0) NOT NULL DEFAULT 0,
  last_bet_at     TIMESTAMPTZ,
  PRIMARY KEY (bettor_address, token)
);

-- Ensure token column exists
ALTER TABLE betting_leaderboard
  ADD COLUMN IF NOT EXISTS token TEXT NOT NULL DEFAULT 'MON';

-- Adjust primary key to include token
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  table_name = 'betting_leaderboard'
    AND    constraint_type = 'PRIMARY KEY'
    AND    constraint_name = 'betting_leaderboard_pkey'
  ) THEN
    ALTER TABLE betting_leaderboard DROP CONSTRAINT betting_leaderboard_pkey;
  END IF;
END$$;

ALTER TABLE betting_leaderboard
  ADD CONSTRAINT betting_leaderboard_pkey PRIMARY KEY (bettor_address, token);

COMMIT;
