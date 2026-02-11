#!/bin/bash
set -e

echo "=== Railway Deployment Script for Claw-Stuff ==="
echo ""

# Step 1: Authenticate (if not already)
echo "Step 1: Checking Railway authentication..."
if ! railway whoami &>/dev/null; then
    echo "Not authenticated. Running railway login..."
    railway login
else
    echo "Already authenticated to Railway"
fi

# Step 2: Create new project
echo ""
echo "Step 2: Creating new Railway project..."
cd /tmp/claw-stuff
railway init --name "claw-stuff-server"

# Step 3: Add Postgres addon
echo ""
echo "Step 3: Adding Postgres database..."
railway add --plugin postgresql

# Step 4: Set environment variables
echo ""
echo "Step 4: Setting environment variables..."
railway variables set NODE_ENV=production
railway variables set RUN_HOUSE_BOTS=false
railway variables set BETTING_ENABLED=false
railway variables set CLIENT_URL=https://builder-arena.vercel.app

# Step 5: Link GitHub repo (manual step - will provide instructions)
echo ""
echo "Step 5: GitHub repo connection..."
echo "⚠️  MANUAL STEP REQUIRED:"
echo "1. Go to Railway dashboard: https://railway.app/dashboard"
echo "2. Select the 'claw-stuff-server' project"
echo "3. Click 'Settings' → 'Connect Repo'"
echo "4. Select 'shirollsasaki/claw-stuff'"
echo "5. Set root directory to '/' (default)"
echo "6. Railway will auto-deploy on connection"
echo ""
read -p "Press Enter after connecting GitHub repo..."

# Step 6: Wait for deployment
echo ""
echo "Step 6: Waiting for deployment to complete..."
echo "Checking deployment status..."
sleep 10
railway status

# Step 7: Run database migration
echo ""
echo "Step 7: Running database migration..."
railway run npm run migrate

# Step 8: Get deployment URL
echo ""
echo "Step 8: Getting deployment URL..."
RAILWAY_URL=$(railway domain)
echo "Deployment URL: $RAILWAY_URL"

# Step 9: Verify deployment
echo ""
echo "Step 9: Verifying deployment..."
echo ""

echo "Testing status endpoint..."
curl -s "https://$RAILWAY_URL/api/status" | jq '.currentMatch.phase' || echo "❌ Status endpoint failed"

echo ""
echo "Testing betting disabled..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://$RAILWAY_URL/api/betting/contract-info")
if [ "$HTTP_CODE" = "503" ] || [ "$HTTP_CODE" = "404" ]; then
    echo "✅ Betting is disabled (HTTP $HTTP_CODE)"
else
    echo "⚠️  Betting status unclear (HTTP $HTTP_CODE)"
fi

echo ""
echo "Testing database (global leaderboard)..."
curl -s "https://$RAILWAY_URL/api/global-leaderboard" | jq '.' || echo "❌ Database endpoint failed"

echo ""
echo "Testing CORS..."
curl -s -I -H "Origin: https://builder-arena.vercel.app" "https://$RAILWAY_URL/api/status" | grep -i "access-control-allow-origin" || echo "⚠️  CORS header not found"

echo ""
echo "Testing Socket.IO..."
SOCKET_RESPONSE=$(curl -s "https://$RAILWAY_URL/socket.io/?EIO=4&transport=polling")
if [[ "$SOCKET_RESPONSE" == 0* ]]; then
    echo "✅ Socket.IO handshake successful"
else
    echo "❌ Socket.IO handshake failed"
fi

echo ""
echo "=== Deployment Complete ==="
echo "Railway URL: https://$RAILWAY_URL"
echo ""
echo "Save this URL for subsequent tasks!"
