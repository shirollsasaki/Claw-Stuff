- Kept `/api/betting` mounted with a global 503 fallback in `index.ts` when disabled, while still guarding betting route handlers for defense in depth.

- Renamed auth verifier to `verifyAgentApiKey` and updated all call sites so `grep -ri "moltbook" src/` is clean, while maintaining the same dev test-key flow via `createTestAgent()`.

## Task 5: Railway Deployment Configuration

### Start Command Decision
- **Decision**: Use `npm run migrate && npm start` as start command
- **Rationale**: Ensures database schema is always up-to-date on deployment
- **Alternative Considered**: Separate migration step via Railway CLI
- **Trade-off**: Slightly longer startup time, but guarantees schema consistency
- **Implementation**: Set in both `railway.toml` and `Procfile`

### Environment Variable Strategy
- **Decision**: Disable betting and house bots initially
- **Rationale**: 
  - `BETTING_ENABLED=false` - Builder Arena doesn't use betting features
  - `RUN_HOUSE_BOTS=false` - Task 8 will enable after frontend integration
- **CLIENT_URL**: Set to `https://builder-arena.vercel.app` for CORS

### Deployment Approach
- **Decision**: Provide both CLI and web dashboard deployment options
- **Rationale**: Railway CLI requires interactive auth, web dashboard is more accessible
- **Documentation**: Created comprehensive guides for both approaches
- **Automation**: `railway-deploy.sh` automates CLI approach after user authentication

### Database Migration Strategy
- **Decision**: Provide both TypeScript and SQL migration scripts
- **Rationale**: 
  - TypeScript (`scripts/migrate.ts`) - Preferred, uses existing db.ts connection
  - SQL (`scripts/migrate.sql`) - Fallback for manual execution in Railway console
- **Idempotency**: Both scripts use `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`

