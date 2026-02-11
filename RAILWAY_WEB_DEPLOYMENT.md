# Railway Web Dashboard Deployment Guide

Since Railway CLI requires interactive authentication, follow these steps using the Railway web dashboard.

## Step-by-Step Web Deployment

### 1. Login to Railway
Go to https://railway.app and sign in with your GitHub account.

### 2. Create New Project
1. Click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. If prompted, authorize Railway to access your GitHub account
4. Search for and select **`shirollsasaki/claw-stuff`**
5. Click **"Deploy Now"**

Railway will automatically:
- Detect it's a Node.js project
- Install dependencies
- Build the project
- Start the server

### 3. Add Postgres Database
1. In your project dashboard, click **"New"** → **"Database"** → **"Add PostgreSQL"**
2. Railway will automatically:
   - Create a Postgres instance
   - Set the `DATABASE_URL` environment variable
   - Link it to your service

### 4. Configure Environment Variables
1. Click on your service (the one connected to GitHub, not the database)
2. Go to **"Variables"** tab
3. Click **"+ New Variable"** and add each of these:

```
NODE_ENV=production
RUN_HOUSE_BOTS=false
BETTING_ENABLED=false
CLIENT_URL=https://builder-arena.vercel.app
```

**Important**: `DATABASE_URL` should already be set automatically by the Postgres addon. Don't modify it.

### 5. Configure Build & Start Commands (if needed)
1. Go to **"Settings"** tab
2. Under **"Build"** section:
   - Build Command: `npm run build` (should be auto-detected)
3. Under **"Deploy"** section:
   - Start Command: `npm run migrate && npm start`
   
   Or if Railway doesn't support chained commands:
   - Start Command: `npm start`
   - Then run migration manually (see step 7)

### 6. Generate Public Domain
1. Go to **"Settings"** tab
2. Scroll to **"Networking"** section
3. Click **"Generate Domain"**
4. Railway will assign a URL like: `claw-stuff-production.up.railway.app`
5. **Copy this URL** - you'll need it for verification

### 7. Run Database Migration

**Option A: Via Railway CLI (if authenticated)**
```bash
railway login
railway link
railway run npm run migrate
```

**Option B: Via Service Settings**
1. Go to **"Settings"** → **"Deploy"**
2. Change Start Command temporarily to: `npm run migrate`
3. Click **"Deploy"** to trigger a new deployment
4. Wait for migration to complete
5. Change Start Command back to: `npm start`
6. Click **"Deploy"** again

**Option C: Via Database Console**
1. Click on the **PostgreSQL** service
2. Go to **"Data"** tab
3. Click **"Query"** to open SQL console
4. Copy and paste the migration SQL from `scripts/migrate.ts`
5. Execute the queries manually

### 8. Verify Deployment

Replace `YOUR_RAILWAY_URL` with your actual domain from step 6.

**Test 1: Server Status**
```bash
curl -s https://YOUR_RAILWAY_URL/api/status
```
Expected: JSON with `currentMatch` object

**Test 2: HTTP Status Code**
```bash
curl -s -o /dev/null -w "%{http_code}" https://YOUR_RAILWAY_URL/api/status
```
Expected: `200`

**Test 3: Betting Disabled**
```bash
curl -s https://YOUR_RAILWAY_URL/api/betting/contract-info
```
Expected: Error or "disabled" message (HTTP 503 or 404)

**Test 4: Database Works**
```bash
curl -s https://YOUR_RAILWAY_URL/api/global-leaderboard
```
Expected: JSON array (may be empty `[]` if no matches yet)

**Test 5: CORS Configured**
```bash
curl -s -I -H "Origin: https://builder-arena.vercel.app" https://YOUR_RAILWAY_URL/api/status | grep -i "access-control"
```
Expected: `access-control-allow-origin` header present

**Test 6: Socket.IO Handshake**
```bash
curl -s "https://YOUR_RAILWAY_URL/socket.io/?EIO=4&transport=polling"
```
Expected: Response starting with `0{` (Socket.IO handshake)

### 9. Monitor Deployment
- **Logs**: Click on your service → **"Deployments"** tab → Click latest deployment → View logs
- **Metrics**: **"Metrics"** tab shows CPU, memory, network usage
- **Health**: Service should show green "Active" status

## Troubleshooting

### Build Fails
**Check logs**: Service → Deployments → Latest deployment → View build logs

Common issues:
- Missing dependencies: Check `package.json`
- TypeScript errors: Run `npm run build` locally first
- Node version: Railway uses Node 18+ by default

### Migration Fails
**Check database connection**:
1. Click PostgreSQL service
2. Go to **"Connect"** tab
3. Copy connection URL
4. Test locally: `psql "YOUR_DATABASE_URL"`

**Manual migration**:
```bash
export DATABASE_URL="your_railway_postgres_url"
npm run migrate
```

### Service Won't Start
**Check environment variables**:
- `DATABASE_URL` must be set (auto-set by Postgres addon)
- `PORT` is auto-set by Railway (don't override)
- `NODE_ENV=production`

**Check start command**:
- Should be: `npm start` or `node dist/server/index.js`
- Make sure `npm run build` completed successfully

### No Domain Generated
1. Settings → Networking → Generate Domain
2. If button is disabled, check if service is deployed successfully
3. Try redeploying: Deployments → Latest → Redeploy

### CORS Errors
Verify `CLIENT_URL` environment variable:
```
CLIENT_URL=https://builder-arena.vercel.app
```

Check `src/server/index.ts` CORS configuration.

## Environment Variables Reference

| Variable | Value | Set By | Required |
|----------|-------|--------|----------|
| `DATABASE_URL` | `postgresql://...` | Railway (auto) | Yes |
| `PORT` | `3000` or Railway-assigned | Railway (auto) | Yes |
| `NODE_ENV` | `production` | Manual | Yes |
| `RUN_HOUSE_BOTS` | `false` | Manual | Yes |
| `BETTING_ENABLED` | `false` | Manual | Yes |
| `CLIENT_URL` | `https://builder-arena.vercel.app` | Manual | Yes |

## Next Steps

After successful deployment:

1. **Record Railway URL** in project notepad:
   ```
   .sisyphus/notepads/claw-deep-integration/learnings.md
   ```

2. **Test from Builder Arena**:
   - Update Builder Arena frontend to use new Claw server URL
   - Test WebSocket connections
   - Verify game state updates

3. **Enable House Bots** (Task 8):
   - Set `RUN_HOUSE_BOTS=true` in environment variables
   - Redeploy service

4. **Monitor Performance**:
   - Check Railway metrics dashboard
   - Monitor logs for errors
   - Watch database query performance

## Railway Dashboard Quick Links

- **Project Dashboard**: https://railway.app/dashboard
- **Postgres Docs**: https://docs.railway.app/databases/postgresql
- **Environment Variables**: https://docs.railway.app/develop/variables
- **Custom Domains**: https://docs.railway.app/deploy/exposing-your-app

## Cost Considerations

Railway pricing (as of 2024):
- **Free tier**: $5 credit/month
- **Pro plan**: $20/month + usage
- **Postgres**: ~$5-10/month depending on usage
- **Compute**: ~$0.000463/GB-hour

Estimated monthly cost for this project: $10-15/month

Monitor usage: Dashboard → Project → Usage tab
