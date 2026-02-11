# Task 4: Spectator UI Branding & Betting Tab Gating

## Summary
Successfully updated the Claw-Stuff spectator HTML to reference Builder Arena branding and implemented conditional visibility for BETS/TOKEN tabs based on the `BETTING_ENABLED` config flag.

## Changes Made

### 1. HTML Branding Updates (`public/index.html`)
- Updated page title: "Claw IO" → "Claw IO — Builder Arena"
- Updated PLAY tab instructions: "Send Your AI Agent to Claw IO Games" → "Send Your AI Agent to Builder Arena"
- Updated PLAY tab (Agent): "Join the Claw IO Games" → "Join Builder Arena"
- Added `data-betting-tab="true"` attribute to BETS and TOKEN tab buttons for easy JS targeting

### 2. API Endpoint Enhancement (`src/server/api/routes.ts`)
- Imported `config` module
- Modified `/api/status` endpoint to include `bettingEnabled` flag in response
- Response now includes: `{ ...status, bettingEnabled: config.bettingEnabled }`

### 3. Client-Side Betting Config Initialization (`public/client/main.js`)
- Added `initBettingConfig()` async function that:
  - Fetches `/api/status` on page load
  - Extracts `bettingEnabled` flag from response
  - Toggles visibility of BETS/TOKEN tabs using `display: none` when disabled
  - Defaults to hiding tabs on fetch error (safe fallback)
- Called `initBettingConfig()` before Socket.IO connection

## Verification Results

✅ **Branding**: 3 references to "Builder Arena" in HTML
✅ **Tab Markup**: All 4 tabs (PLAY, SKINS, BETS, TOKEN) remain in HTML
✅ **Betting Tab Markers**: Both BETS and TOKEN tabs have `data-betting-tab="true"`
✅ **Config Fetch**: main.js fetches and processes betting config
✅ **API Exposure**: `/api/status` includes `bettingEnabled` flag
✅ **Build**: `npm run build` exits with code 0
✅ **BETTING_ENABLED=false**: API returns `bettingEnabled: false`
✅ **BETTING_ENABLED=true**: API returns `bettingEnabled: true`

## Implementation Details

### Tab Visibility Logic
```javascript
// When BETTING_ENABLED=false:
// - BETS and TOKEN tabs have style.display = 'none'
// - PLAY and SKINS tabs remain visible
// - All betting UI code remains intact in HTML (just hidden)

// When BETTING_ENABLED=true:
// - All 4 tabs visible (style.display = '')
// - Full betting functionality available
```

### Betting Code Preservation
- ✅ No betting UI code was deleted
- ✅ No wallet connect code was removed
- ✅ No tab markup was deleted
- ✅ Only visibility is gated via CSS `display` property
- ✅ All betting event handlers remain functional when tabs are visible

## Testing Performed

1. **Build Test**: `npm run build` succeeds with no errors
2. **API Test**: `/api/status` returns correct `bettingEnabled` value
3. **HTML Test**: All 4 tabs present in markup with proper attributes
4. **Integration Test**: Server responds correctly with both config values
5. **LSP Diagnostics**: No TypeScript or JavaScript errors

## Deployment Notes

- When deploying with `BETTING_ENABLED=false`: BETS/TOKEN tabs will be hidden on page load
- When deploying with `BETTING_ENABLED=true`: All tabs visible and betting fully functional
- No database migrations required
- No breaking changes to existing APIs
- Backward compatible with existing clients

## Future Enhancements

- Could add CSS class instead of inline `display: none` for easier styling
- Could add transition animation when toggling tab visibility
- Could add feature flag for other UI elements (e.g., wallet connect button)
