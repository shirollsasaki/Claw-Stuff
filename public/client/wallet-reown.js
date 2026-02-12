/**
 * Reown AppKit (wallet connect modal) – initializes when REOWN_PROJECT_ID is set.
 * Pattern aligned with shotgun-app: createAppKit + EthersAdapter + viem defineChain.
 * Exposes window.openReownConnect() to open the Reown modal instead of direct MetaMask.
 */
window.useReownConnect = false;
window.reownReady = false;
window.reownInitFailed = false;
window.openReownConnect = null;

async function initReown() {
    try {
      const res = await fetch('/api/betting/contract-info');
      const data = await res.json();
      const projectId = data.reownProjectId;
      if (!projectId || typeof projectId !== 'string') return;

      // Same versions as shotgun-app: AppKit 1.8.x, viem for defineChain
      const V = '1.8.17';
      const { createAppKit } = await import('https://esm.sh/@reown/appkit@' + V);
      const { EthersAdapter } = await import('https://esm.sh/@reown/appkit-adapter-ethers@' + V);
      const { defineChain } = await import('https://esm.sh/viem@2');

       // Base Mainnet – same shape as shotgun-app (viem defineChain)
       const baseMainnet = defineChain({
         id: 8453,
         name: 'Base',
         nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
         rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
         blockExplorers: {
           default: { name: 'Basescan', url: 'https://basescan.org' },
         },
         testnet: false,
       });

       const metadata = {
         name: 'Claw IO',
         description: 'Bet on AI agents in Claw IO',
         url: window.location.origin,
         icons: [],
       };

       const modal = createAppKit({
         adapters: [new EthersAdapter()],
         networks: [baseMainnet],
        projectId,
        metadata,
        features: {
          analytics: false,
          email: false,
          socials: false,
          emailShowWallets: false,
        },
        themeMode: 'dark',
        themeVariables: {
          '--w3m-accent': '#d946ef',
        },
      });

      // Track connection state using vanilla AppKit getters + subscriptions
      // (subscribeProvider is React-only; vanilla uses subscribeState/subscribeProviders + getters)
      let wasConnected = false;

      function getProvider() {
        // Try getWalletProvider() first, then getProviders()['eip155']
        try { var p = modal.getWalletProvider(); if (p) return p; } catch (_) {}
        try { var ps = modal.getProviders(); if (ps && ps['eip155']) return ps['eip155']; } catch (_) {}
        return null;
      }

      function checkConnection() {
        try {
          var address = null;
          try { address = modal.getAddress(); } catch (_) {}
          var walletProvider = getProvider();

          // Use address + provider as the real connection indicator
          // (getIsConnected() returns false for injected wallets like MetaMask)
          var effectivelyConnected = !!(address && walletProvider);

          console.log('[Reown] check:', { address: address || '(none)', hasProvider: !!walletProvider, effectivelyConnected, wasConnected });

          window.__reownState = { isConnected: effectivelyConnected, provider: walletProvider, address };

          if (effectivelyConnected && !wasConnected) {
            wasConnected = true;
            console.log('[Reown] Dispatching reown-wallet-connected, address=' + address);
            window.dispatchEvent(
              new CustomEvent('reown-wallet-connected', { detail: { provider: walletProvider, address } })
            );
          } else if (!effectivelyConnected && wasConnected) {
            wasConnected = false;
            console.log('[Reown] Dispatching reown-wallet-disconnected');
            window.dispatchEvent(new CustomEvent('reown-wallet-disconnected'));
          }
        } catch (err) { console.warn('[Reown] checkConnection error:', err); }
      }

      // React to modal open/close and any internal state change
      modal.subscribeState(function (state) {
        console.log('[Reown] subscribeState fired:', state);
        // Delay slightly so AppKit internal state settles after modal close
        setTimeout(checkConnection, 300);
      });

      // Also subscribe to provider changes by namespace (eip155 = EVM)
      if (typeof modal.subscribeProviders === 'function') {
        modal.subscribeProviders(function (providers) {
          console.log('[Reown] subscribeProviders fired:', Object.keys(providers || {}));
          setTimeout(checkConnection, 300);
        });
      }

      // Also try subscribeAccount if available
      if (typeof modal.subscribeAccount === 'function') {
        modal.subscribeAccount(function (account) {
          console.log('[Reown] subscribeAccount fired:', account);
          setTimeout(checkConnection, 300);
        });
      }

      // List all modal methods for debugging
      console.log('[Reown] modal methods:', Object.keys(modal).filter(function (k) { return typeof modal[k] === 'function'; }));

      // Poll every 1s indefinitely while page is open to catch connection changes
      setInterval(function () { checkConnection(); }, 1000);

      window.openReownConnect = function () {
        modal.open({ view: 'Connect' });
      };

      window.reownModal = modal;
      window.useReownConnect = true;
      window.reownReady = true;
      window.dispatchEvent(new Event('reown-ready'));
    } catch (err) {
    console.warn('[Reown] Init failed, falling back to direct MetaMask:', err);
    window.reownInitFailed = true;
  }
}

initReown();
