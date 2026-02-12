# Claw Betting Integration - Learnings

## Monad → Base Migration (ETH-only)

### Changes Made
1. **betting.js** (lines 5, 25-39, 87-94, 580):
   - Updated comment: "Monad mainnet" → "Base mainnet"
   - Commented out `MCLAW_TOKEN_ADDRESS` (ETH-only, no ERC-20 token)
   - Changed `TOKEN_META.MON.symbol` from 'MON' to 'ETH'
   - Renamed `MONAD_MAINNET` → `BASE_MAINNET`:
     - `chainId: '0x8f'` (143) → `'0x2105'` (8453)
     - `chainName: 'Monad'` → `'Base'`
     - `rpcUrls: ['https://rpc.monad.xyz']` → `['https://mainnet.base.org']`
     - `nativeCurrency: { name: 'MON', symbol: 'MON' }` → `{ name: 'ETH', symbol: 'ETH' }`
     - `blockExplorerUrls: ['https://monadvision.com']` → `['https://basescan.org']`
   - Updated explorer link: `monadvision.com/tx/` → `basescan.org/tx/`

2. **wallet-reown.js** (lines 24-45):
   - Renamed `monadMainnet` → `baseMainnet`
   - Updated viem defineChain:
     - `id: 143` → `id: 8453`
     - `name: 'Monad'` → `name: 'Base'`
     - `nativeCurrency: { name: 'MON', symbol: 'MON' }` → `{ name: 'ETH', symbol: 'ETH' }`
     - `rpcUrls: { default: { http: ['https://rpc.monad.xyz/'] } }` → `{ default: { http: ['https://mainnet.base.org'] } }`
     - `blockExplorers: { default: { name: 'MonadVision', url: 'https://monadvision.com' } }` → `{ default: { name: 'Basescan', url: 'https://basescan.org' } }`

3. **index.html** (line 515-516):
   - Changed MON button label to "ETH"
   - Added `hidden` class to MCLAW button (UI hidden, code preserved)

### Key Decisions
- **Kept `currentBetToken = 'MON'`**: Internal enum for API compatibility; display label changed to ETH
- **Commented out MCLAW_TOKEN_ADDRESS**: Preserves original address for reference; prevents accidental use
- **Preserved MCLAW code**: Hidden UI but kept logic for future re-enablement if needed
- **No structural changes**: Maintained WebSocket event handling, bet placement flow, claim logic

### Verification
- ✓ No Monad references in betting.js (except comment referencing original token)
- ✓ Base chain config present (basescan, 0x2105, mainnet.base.org)
- ✓ MCLAW token switcher hidden
- ✓ No JavaScript syntax errors
- ✓ Commit: `feat(betting): migrate spectator frontend from Monad to Base (ETH-only)`

### Testing Notes
- Wallet connection will now request Base chain (0x2105)
- MetaMask will add Base network if not present
- Reown modal will show Base as the only available network
- All explorer links point to basescan.org
- Token display shows "ETH" instead of "MON"
