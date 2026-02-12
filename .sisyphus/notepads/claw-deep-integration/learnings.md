- Added a simple `config.bettingEnabled` boolean (from `BETTING_ENABLED === 'true'`) and used it to gate execution without removing betting assets.

- Builder Arena auth can stay local and deterministic: accept only `ba_` keys with regex validation and derive `AgentInfo.name` directly from the suffix, while preserving `test_` behavior in development.

## Task 5: Railway Deployment Preparation

### Deployment Configuration
- Created `railway.toml` with NIXPACKS builder
- Start command: `npm run migrate && npm start` (runs migration before starting server)
- Restart policy: ON_FAILURE with 10 max retries
- Created `Procfile` as alternative process definition

### Environment Variables Required
```bash
NODE_ENV=production
RUN_HOUSE_BOTS=false          # Disabled initially, Task 8 will enable
BETTING_ENABLED=false         # Betting disabled for Builder Arena integration
CLIENT_URL=https://builder-arena.vercel.app
DATABASE_URL                  # Auto-set by Railway Postgres addon
PORT                          # Auto-set by Railway
```

### Database Migration
- Migration script: `scripts/migrate.ts` (TypeScript)
- SQL version: `scripts/migrate.sql` (for manual execution in Railway console)
- Tables created:
  - `agents` - Moltbook agent registry (name, api_key, wallet_address)
  - `matches` - Match history (id, winner_name, ended_at)
  - `match_players` - Per-agent match stats (match_id, agent_name, score, kills, skin_id)
  - `agent_skins` - Skin ownership (agent_name, skin_id, granted_at)
  - `betting_pools` - Match betting pools (disabled but schema exists)
  - `bets` - Individual bets (disabled)
  - `bet_settlements` - Payout records (disabled)
  - `betting_leaderboard` - Bettor stats (disabled)

### Deployment Scripts
- **railway-deploy.sh**: Automated deployment script
  - Authenticates to Railway
  - Creates project "claw-stuff-server"
  - Adds Postgres addon
  - Sets environment variables
  - Prompts for GitHub repo connection (manual step)
  - Runs migration
  - Verifies all endpoints
  - Displays Railway URL

### Documentation Created
- `RAILWAY_DEPLOYMENT.md` - CLI deployment guide
- `RAILWAY_WEB_DEPLOYMENT.md` - Web dashboard deployment guide (detailed)
- `/tmp/RAILWAY_DEPLOYMENT_INSTRUCTIONS.md` - Master instructions
- `/tmp/DEPLOYMENT_STATUS.md` - Status summary
- `/tmp/TASK_5_COMPLETION_REPORT.md` - Completion report

### Railway CLI Limitation
- `railway login` requires interactive browser authentication
- Cannot be automated in non-interactive environment
- User must run `railway login` manually
- After auth, `railway-deploy.sh` automates the rest

### Verification Endpoints
After deployment, verify:
1. `/api/status` - Returns 200 with currentMatch object
2. `/api/betting/contract-info` - Returns 503/404 (betting disabled)
3. `/api/global-leaderboard` - Returns JSON array (database works)
4. CORS header for `https://builder-arena.vercel.app` origin
5. `/socket.io/?EIO=4&transport=polling` - Socket.IO handshake (starts with "0{")

### Git Commits
- `0c72a58` - Add Railway deployment configuration and scripts
- `69c3416` - Add web deployment guide and SQL migration script
- Both pushed to `shirollsasaki/claw-stuff` main branch

### Next Steps
- User must run `railway login` and execute deployment
- User provides Railway URL
- Record URL in this notepad
- Proceed to Task 6: Update Builder Arena frontend


## Task: Preflight Validation & DB Migration

### Contract Preflight Validation ✅ PASSED
All three Base mainnet contract view calls returned expected values:

1. **operator()** → `0xa701EF934E997829591Dce1891619010f03b3c08` ✅
2. **treasury()** → `0xF51Fe86498b83538E902e160F2D80c34C7d6b816` ✅
3. **minBetAmount()** → `10000000000000000` (1e16) ✅

Contract address: `0x9daD403877C571404F4F9EAFED6C320E38e68e34`
RPC endpoint: `https://mainnet.base.org`

### Database Migration Status
Migration script verified: `/tmp/claw-stuff/scripts/migrate.sql`
- Creates 4 betting tables: betting_pools, bets, bet_settlements, betting_leaderboard
- Idempotent (uses CREATE TABLE IF NOT EXISTS)
- Includes wallet_address column on agents table

**Blocker**: Railway authentication required
- `railway login` requires interactive browser authentication
- Cannot proceed without Railway CLI authentication or DATABASE_URL
- Next step: User must authenticate with Railway and provide DATABASE_URL or run migration via Railway dashboard

### Migration Execution Steps (when DATABASE_URL available)
```bash
# Option 1: Direct psql
psql $DATABASE_URL -f /tmp/claw-stuff/scripts/migrate.sql

# Option 2: Via npm script
npm run migrate

# Option 3: Via Railway CLI (after authentication)
railway run npm run migrate
```

### Verification Command
```bash
psql $DATABASE_URL -c "\dt betting_*"
```
Should show: betting_pools, bets, bet_settlements, betting_leaderboard

