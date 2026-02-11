# Railway Deployment Guide for Claw-Stuff Server

## Prerequisites
- Railway CLI installed: `brew install railway` (already installed)
- GitHub repo: `shirollsasaki/claw-stuff` (already created)
- Railway account: https://railway.app

## Automated Deployment (Recommended)

Run the deployment script:
```bash
cd /tmp/claw-stuff
./railway-deploy.sh
```

The script will:
1. Authenticate to Railway
2. Create new project "claw-stuff-server"
3. Add Postgres database
4. Set environment variables
5. Prompt you to connect GitHub repo (manual step)
6. Run database migration
7. Verify all endpoints

## Manual Deployment Steps

### 1. Authenticate to Railway
```bash
railway login
```

### 2. Initialize Project
```bash
cd /tmp/claw-stuff
railway init --name "claw-stuff-server"
```

### 3. Add Postgres Database
```bash
railway add --plugin postgresql
```

This automatically sets `DATABASE_URL` environment variable.

### 4. Set Environment Variables
```bash
railway variables set NODE_ENV=production
railway variables set RUN_HOUSE_BOTS=false
railway variables set BETTING_ENABLED=false
railway variables set CLIENT_URL=https://builder-arena.vercel.app
```

### 5. Connect GitHub Repository

**Option A: Via CLI (if supported)**
```bash
railway connect shirollsasaki/claw-stuff
```

**Option B: Via Dashboard (recommended)**
1. Go to https://railway.app/dashboard
2. Select "claw-stuff-server" project
3. Click "Settings" → "Connect Repo"
4. Select `shirollsasaki/claw-stuff`
5. Set root directory: `/` (default)
6. Railway will auto-deploy on connection

### 6. Wait for Deployment
```bash
railway status
```

Monitor deployment logs:
```bash
railway logs
```

### 7. Run Database Migration
```bash
railway run npm run migrate
```

Or connect to the service and run:
```bash
railway run --service claw-stuff-server npm run migrate
```

### 8. Get Deployment URL
```bash
railway domain
```

Or generate a domain:
```bash
railway domain --generate
```

### 9. Verify Deployment

Replace `YOUR_RAILWAY_URL` with your actual Railway domain:

**Status Endpoint:**
```bash
curl -s https://YOUR_RAILWAY_URL/api/status | jq '.currentMatch.phase'
```
Expected: "lobby", "active", or "finished"

**Betting Disabled:**
```bash
curl -s -o /dev/null -w "%{http_code}" https://YOUR_RAILWAY_URL/api/betting/contract-info
```
Expected: 503 or 404

**Database Works:**
```bash
curl -s https://YOUR_RAILWAY_URL/api/global-leaderboard | jq '.'
```
Expected: Valid JSON array

**CORS Configured:**
```bash
curl -s -I -H "Origin: https://builder-arena.vercel.app" https://YOUR_RAILWAY_URL/api/status | grep -i "access-control-allow-origin"
```
Expected: Contains "builder-arena.vercel.app" or "*"

**Socket.IO Works:**
```bash
curl -s "https://YOUR_RAILWAY_URL/socket.io/?EIO=4&transport=polling"
```
Expected: Response starts with "0{"

## Environment Variables Summary

| Variable | Value | Source |
|----------|-------|--------|
| `DATABASE_URL` | Auto-set by Railway Postgres addon | Railway |
| `NODE_ENV` | `production` | Manual |
| `PORT` | Auto-set by Railway | Railway |
| `RUN_HOUSE_BOTS` | `false` | Manual |
| `BETTING_ENABLED` | `false` | Manual |
| `CLIENT_URL` | `https://builder-arena.vercel.app` | Manual |

## Troubleshooting

### Migration Fails
```bash
railway logs
railway run psql $DATABASE_URL
```

Check if tables exist:
```sql
\dt
```

### Deployment Fails
Check build logs:
```bash
railway logs --deployment
```

### Domain Not Generated
```bash
railway domain --generate
```

### Service Not Starting
Check environment variables:
```bash
railway variables
```

## Next Steps

After successful deployment:
1. Record Railway URL in `.sisyphus/notepads/claw-deep-integration/learnings.md`
2. Update Builder Arena frontend to use new Claw server URL
3. Test WebSocket connections from Builder Arena
4. Enable house bots in Task 8 (set `RUN_HOUSE_BOTS=true`)

## Railway Dashboard

Access your project: https://railway.app/dashboard

From the dashboard you can:
- View deployment logs
- Monitor resource usage
- Manage environment variables
- Configure custom domains
- View database metrics
