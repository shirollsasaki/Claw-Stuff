- `BETTING_ENABLED` appears only once (in config) by design; wiring evidence is better validated via `config.bettingEnabled` references across server files.

- `grep` over the full repo still finds legacy docs text outside `src/` (for example `README.md`/`SKILL.md`), so verification for this task should use `src/` scope as specified.

## Task 5: Railway Deployment

### Railway CLI Authentication Blocker
- **Issue**: `railway login` requires interactive browser authentication
- **Impact**: Cannot fully automate deployment from non-interactive environment
- **Workaround**: Created comprehensive deployment scripts and documentation for user to execute
- **Files Created**:
  - `railway-deploy.sh` - Automated script (requires user to run `railway login` first)
  - `RAILWAY_WEB_DEPLOYMENT.md` - Alternative web dashboard guide
  - `scripts/migrate.sql` - SQL migration for manual execution
- **Resolution**: User must authenticate and run deployment script manually

### Migration Execution Options
- **Option 1**: `railway run npm run migrate` (requires Railway CLI auth)
- **Option 2**: Run SQL directly in Railway Postgres console
- **Option 3**: Set start command to `npm run migrate && npm start` (runs on every deploy)
- **Chosen**: Option 3 in railway.toml for automatic migration on deployment

