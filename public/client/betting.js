/**
 * Claw IO – Betting / Prediction Market frontend logic.
 *
 * Handles:
 *  - MetaMask / injected wallet connection (Base mainnet)
 *  - Placing bets on-chain via ClawBetting contract
 *  - Real-time odds updates via WebSocket
 *  - Toast notifications
 *  - My bets panel, claim flow, leaderboard
 */

/* ================================================================
   State
   ================================================================ */
let walletAddress = null;
let provider = null;      // ethers BrowserProvider
let signer = null;        // ethers Signer
let bettingContract = null;
let contractAddress = '';
let contractABI = [];
let currentBettingStatus = null; // latest BettingStatus from server
let currentMatchId = null;
let currentBetToken = 'MON';     // 'MON' | 'MCLAW'

// $MClawIO token (Monad) – same CA as TOKEN tab
// COMMENTED OUT: ETH-only migration (Base chain)
// const MCLAW_TOKEN_ADDRESS = '0x26813a9B80f43f98cee9045B9f7CdcA816C57777';

const TOKEN_META = {
  MON:   { symbol: 'ETH' },
  MCLAW: { symbol: 'MClawIO' },
};

const BASE_MAINNET = {
  chainId: '0x2105',          // 8453
  chainName: 'Base',
  rpcUrls: ['https://mainnet.base.org'],
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  blockExplorerUrls: ['https://basescan.org'],
};

/* ================================================================
   Wallet Connection
   ================================================================ */
window.connectWallet = async function connectWallet() {
  // Prefer Reown wallet connect modal when configured (may still be initializing)
  if (typeof window.openReownConnect === 'function') {
    window.openReownConnect();
    return;
  }
  // Reown loads async (fetch + dynamic import). Wait for it before falling back to MetaMask.
  if (window.reownReady === false && !window.reownInitFailed) {
    showToast('Loading wallet options…', 'info');
    try {
      await new Promise(function (resolve, reject) {
        const t = setTimeout(function () {
          reject(new Error('timeout'));
        }, 8000);
        window.addEventListener('reown-ready', function onReady() {
          clearTimeout(t);
          window.removeEventListener('reown-ready', onReady);
          resolve();
        }, { once: true });
      });
      if (typeof window.openReownConnect === 'function') {
        window.openReownConnect();
        return;
      }
    } catch (_) {
      window.reownInitFailed = true;
    }
  }

  if (!window.ethereum) {
    showToast('No wallet detected. Install MetaMask or another browser wallet.', 'error');
    return;
  }

  try {
    // Request accounts
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    walletAddress = accounts[0];

     // Ensure correct chain
     try {
       await window.ethereum.request({
         method: 'wallet_switchEthereumChain',
         params: [{ chainId: BASE_MAINNET.chainId }],
       });
     } catch (switchErr) {
       if (switchErr.code === 4902) {
         await window.ethereum.request({
           method: 'wallet_addEthereumChain',
           params: [BASE_MAINNET],
         });
       } else {
         throw switchErr;
       }
     }

    // Set up ethers
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    walletAddress = await signer.getAddress();

    // Load contract info from backend
    await loadContractInfo();

    // Update UI
    updateWalletUI();
    showToast(`Wallet connected: ${shortenAddr(walletAddress)}`, 'success');

    // Refresh betting data
    if (currentMatchId) {
      fetchBettingStatus(currentMatchId);
      fetchMyBets(currentMatchId);
    }
  } catch (err) {
    console.error('Wallet connection failed:', err);
    showToast('Wallet connection failed: ' + (err.message || err), 'error');
  }
};

async function loadContractInfo() {
  try {
    const res = await fetch('/api/betting/contract-info');
    const data = await res.json();
    contractAddress = data.contractAddress || '';
    contractABI = data.abi || [];
    if (contractAddress && contractABI.length && signer) {
      bettingContract = new ethers.Contract(contractAddress, contractABI, signer);
    }
  } catch (err) {
    console.error('Failed to load contract info:', err);
  }
}

function updateWalletUI() {
  const btn = document.getElementById('wallet-connect-btn');
  const disconnected = document.getElementById('betting-wallet-disconnected');
  const connected = document.getElementById('betting-wallet-connected');
  const addrEl = document.getElementById('betting-wallet-addr');
  const balEl = document.getElementById('betting-wallet-balance');
  const symEl = document.getElementById('betting-wallet-symbol');

  if (walletAddress) {
    if (btn) btn.textContent = shortenAddr(walletAddress);
    if (disconnected) disconnected.classList.add('hidden');
    if (connected) connected.classList.remove('hidden');
    if (addrEl) addrEl.textContent = shortenAddr(walletAddress);

    const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
    if (symEl) symEl.textContent = tokenMeta.symbol;

    // Fetch balance for selected token
    if (provider && balEl) {
      if (currentBetToken === 'MON') {
        provider.getBalance(walletAddress).then(bal => {
          balEl.textContent = parseFloat(ethers.formatEther(bal)).toFixed(3);
        }).catch(() => {});
      } else {
        // MClawIO ERC-20 balance
        const erc20Abi = [
          'function balanceOf(address owner) view returns (uint256)',
        ];
        const mclaw = new ethers.Contract(MCLAW_TOKEN_ADDRESS, erc20Abi, provider);
        mclaw.balanceOf(walletAddress).then(bal => {
          balEl.textContent = parseFloat(ethers.formatUnits(bal, 18)).toFixed(3);
        }).catch(() => {});
      }
    }
  }
}

// Reown: when user connects via the Reown modal, wire ethers and UI
window.addEventListener('reown-wallet-connected', async function (e) {
  const { provider: reownProvider, address } = e.detail || {};
  if (!reownProvider || !address) return;
  try {
    provider = new ethers.BrowserProvider(reownProvider);
    signer = await provider.getSigner();
    walletAddress = address;
    await loadContractInfo();
    updateWalletUI();
    showToast('Wallet connected: ' + shortenAddr(walletAddress), 'success');
    if (currentMatchId) {
      fetchBettingStatus(currentMatchId);
      fetchMyBets(currentMatchId);
    }
  } catch (err) {
    console.error('Reown wallet setup failed:', err);
    showToast('Wallet setup failed: ' + (err.message || err), 'error');
  }
});

window.addEventListener('reown-wallet-disconnected', function () {
  walletAddress = null;
  signer = null;
  provider = null;
  bettingContract = null;
  const btn = document.getElementById('wallet-connect-btn');
  if (btn) btn.textContent = 'Connect Wallet';
  const disconnected = document.getElementById('betting-wallet-disconnected');
  const connected = document.getElementById('betting-wallet-connected');
  if (disconnected) disconnected.classList.remove('hidden');
  if (connected) connected.classList.add('hidden');
});

// Listen for account/chain changes (when not using Reown)
if (window.ethereum) {
  window.ethereum.on('accountsChanged', (accounts) => {
    if (window.useReownConnect) return; // Reown handles connect/disconnect
    if (accounts.length === 0) {
      walletAddress = null;
      signer = null;
      bettingContract = null;
      const btn = document.getElementById('wallet-connect-btn');
      if (btn) btn.textContent = 'Connect Wallet';
      const disconnected = document.getElementById('betting-wallet-disconnected');
      const connected = document.getElementById('betting-wallet-connected');
      if (disconnected) disconnected.classList.remove('hidden');
      if (connected) connected.classList.add('hidden');
    } else {
      walletAddress = accounts[0];
      connectWallet();
    }
  });
  window.ethereum.on('chainChanged', () => { window.location.reload(); });
}

/* ================================================================
   Betting Sub-Tabs
   ================================================================ */
window.switchBetSubTab = function switchBetSubTab(tab) {
  ['agents', 'mybets', 'leaders'].forEach(id => {
    const panel = document.getElementById(`bet-panel-${id}`);
    const btn = document.getElementById(`bet-sub-${id}`);
    if (panel) panel.classList.add('hidden');
    if (btn) {
      btn.classList.remove('bg-[#d946ef]', 'text-white');
      btn.classList.add('bg-slate-700', 'text-slate-300');
    }
  });
  const panel = document.getElementById(`bet-panel-${tab}`);
  const btn = document.getElementById(`bet-sub-${tab}`);
  if (panel) panel.classList.remove('hidden');
  if (btn) {
    btn.classList.remove('bg-slate-700', 'text-slate-300');
    btn.classList.add('bg-[#d946ef]', 'text-white');
  }

  if (tab === 'leaders') fetchLeaderboard();
  if (tab === 'mybets' && currentMatchId) fetchMyBets(currentMatchId);
};

// Switch between MON and MClawIO betting pools
window.switchBetToken = function switchBetToken(token) {
  const normalized = token === 'MCLAW' ? 'MCLAW' : 'MON';
  currentBetToken = normalized;
  const btnMon = document.getElementById('bet-token-mon');
  const btnMclaw = document.getElementById('bet-token-mclaw');
  if (btnMon && btnMclaw) {
    if (normalized === 'MON') {
      btnMon.className = 'px-2 py-0.5 bg-black text-[#facc15]';
      btnMclaw.className = 'px-2 py-0.5 bg-transparent text-black/60';
    } else {
      btnMon.className = 'px-2 py-0.5 bg-transparent text-black/60';
      btnMclaw.className = 'px-2 py-0.5 bg-black text-[#facc15]';
    }
  }
  if (currentMatchId) {
    fetchBettingStatus(currentMatchId);
    // Refresh per-token views if their tabs are active
    const myBetsPanel = document.getElementById('bet-panel-mybets');
    if (myBetsPanel && !myBetsPanel.classList.contains('hidden')) {
      fetchMyBets(currentMatchId);
    }
    const leadersPanel = document.getElementById('bet-panel-leaders');
    if (leadersPanel && !leadersPanel.classList.contains('hidden')) {
      fetchLeaderboard();
    }
  }
  // Refresh wallet balance + symbol for selected token
  updateWalletUI();
};

/* ================================================================
   Betting Status & Odds
   ================================================================ */
async function fetchBettingStatus(matchId) {
  try {
    const res = await fetch(`/api/betting/status/${matchId}?token=${encodeURIComponent(currentBetToken)}`);
    const data = await res.json();
    currentBettingStatus = data;
    renderBettingUI(data);
  } catch (err) {
    console.error('Failed to fetch betting status:', err);
  }
}

const AGENT_COLORS = ['#d946ef', '#22d3ee', '#facc15', '#a3e635', '#f97316', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b'];

function renderBettingUI(status) {
  // Phase badge
  const phaseEl = document.getElementById('betting-phase-badge');
  if (phaseEl) {
    const labels = { pending: 'OPENING…', open: 'OPEN', closed: 'LOCKED', resolved: 'SETTLED', cancelled: 'CANCELLED', none: '--' };
    phaseEl.textContent = labels[status.status] || '--';
  }

  // Total pool
  const poolEl = document.getElementById('total-pool-display');
  if (poolEl) poolEl.textContent = status.totalPoolMON || '0';
  const poolSymbolEl = document.getElementById('total-pool-symbol');
  if (poolSymbolEl) {
    const meta = TOKEN_META[status.token || currentBetToken] || TOKEN_META.MON;
    poolSymbolEl.textContent = meta.symbol;
  }

  // Bettor count
  const countEl = document.getElementById('betting-bettor-count');
  if (countEl) countEl.textContent = `${status.bettorCount || 0} bettors`;

  // Pool bar
  const bar = document.getElementById('pool-bar');
  if (bar && status.agents.length > 0) {
    bar.innerHTML = status.agents.map((a, i) => {
      const color = AGENT_COLORS[i % AGENT_COLORS.length];
      const w = Math.max(a.percentage, 2);
      return `<div class="h-full odds-bar-fill" style="width:${w}%;background:${color}" title="${a.agentName}: ${a.percentage.toFixed(1)}%"></div>`;
    }).join('');
  } else if (bar) {
    bar.innerHTML = '';
  }

  // Agent cards
  const list = document.getElementById('betting-list');
  if (!list) return;

  if (!status.agents.length) {
    if (status.status === 'none' || status.status === 'open' || status.status === 'pending') {
      list.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-10 bg-slate-800 border-2 border-dashed border-slate-600">Waiting for players...</div>';
    }
    return;
  }

  list.innerHTML = status.agents.map((agent, i) => {
    const color = AGENT_COLORS[i % AGENT_COLORS.length];
    const isOpen = status.status === 'open';
    const multiplierText = agent.multiplier > 0 ? agent.multiplier.toFixed(2) + 'x' : '--';
    const winRateText = typeof agent.winRate === 'number'
      ? `${(agent.winRate * 100).toFixed(1)}% win`
      : 'win% --';
    const tokenMeta = TOKEN_META[status.token || currentBetToken] || TOKEN_META.MON;
    const payoutHint = agent.multiplier > 0 && agent.multiplier < 1
      ? ' (favorite – less than bet back if win)'
      : agent.multiplier > 0 ? ` (per 1 ${tokenMeta.symbol} bet back if win)` : '';

    return `
      <div class="bg-slate-800 border-2 border-white p-3 shadow-[3px_3px_0_black]">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <div class="w-4 h-4 border-2 border-white" style="background:${color}"></div>
            <div class="flex flex-col">
              <span class="text-sm font-black text-white uppercase">${escHtml(agent.agentName)}</span>
              <span class="text-[10px] font-bold text-slate-400 leading-tight">${winRateText}</span>
            </div>
          </div>
          <div class="text-right" title="If this agent wins: you get this many ${tokenMeta.symbol} per 1 ${tokenMeta.symbol} bet${payoutHint}">
            <div class="text-[9px] font-bold text-slate-400 uppercase">Payout</div>
            <span class="bet-multiplier text-lg neo-font" style="color:${color}">${multiplierText}</span>
          </div>
        </div>
        <div class="flex items-center gap-2 mb-2">
          <div class="flex-1 h-2 bg-slate-900 border border-white/20 overflow-hidden">
            <div class="h-full odds-bar-fill" style="width:${Math.max(agent.percentage, 1)}%;background:${color}"></div>
          </div>
          <span class="text-[10px] font-bold text-slate-400 w-12 text-right" title="Share of total pool">${agent.percentage.toFixed(1)}% pool</span>
        </div>
        <div class="flex items-center justify-between text-[10px] text-slate-400 font-bold mb-2">
          <span>${agent.poolMON} ${tokenMeta.symbol} pooled</span>
          <span>${agent.bettorCount} bettor${agent.bettorCount !== 1 ? 's' : ''}</span>
        </div>
        ${isOpen ? `
        <div class="flex gap-2">
          <input type="number" min="0.01" step="0.01" placeholder="${tokenMeta.symbol}" id="bet-input-${i}"
                 class="flex-1 bg-slate-900 border-2 border-white text-white text-sm px-2 py-1.5 font-mono focus:border-[#facc15] outline-none"
                 style="max-width: 100px;" />
          <button onclick="placeBetOnAgent('${escAttr(agent.agentName)}', ${i})"
                  class="flex-1 py-1.5 text-xs font-black uppercase border-2 border-white text-black shadow-[2px_2px_0_black] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_black] transition-all"
                  style="background:${color}">
            Bet
          </button>
        </div>` : ''}
      </div>
    `;
  }).join('');
}

/* ================================================================
   Place Bet (on-chain)
   ================================================================ */
window.placeBetOnAgent = async function placeBetOnAgent(agentName, inputIndex) {
  if (!walletAddress || !bettingContract) {
    showToast('Connect your wallet first', 'error');
    return;
  }

  const input = document.getElementById(`bet-input-${inputIndex}`);
  if (!input || !input.value || parseFloat(input.value) <= 0) {
    showToast('Enter a valid bet amount', 'error');
    return;
  }

  const tokenUsed = currentBetToken; // capture at click time
  const amountTyped = input.value;
  const amountWei = ethers.parseEther(amountTyped);

  if (!currentMatchId) {
    showToast('No active match to bet on', 'error');
    return;
  }
  if (currentBettingStatus && currentBettingStatus.status !== 'open') {
    showToast('Betting is not open on-chain yet. Wait for the panel to show OPEN.', 'error');
    return;
  }

  try {
    const tokenMeta = TOKEN_META[tokenUsed] || TOKEN_META.MON;
    showToast(`Placing bet of ${amountTyped} ${tokenMeta.symbol} on ${agentName}...`, 'info');

    const matchIdB32 = ethers.encodeBytes32String(currentMatchId.length > 31 ? currentMatchId.slice(0, 31) : currentMatchId);
    const agentIdB32 = ethers.encodeBytes32String(agentName.length > 31 ? agentName.slice(0, 31) : agentName);

    let tx;
    if (tokenUsed === 'MON') {
      // Native MON bet
      tx = await bettingContract.placeBet(matchIdB32, agentIdB32, { value: amountWei });
    } else {
      // $MClawIO ERC-20 bet: ensure approval then call placeMclawBet
      const erc20Abi = [
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
      ];
      const mclaw = new ethers.Contract(MCLAW_TOKEN_ADDRESS, erc20Abi, signer);
      const allowance = await mclaw.allowance(walletAddress, contractAddress);
      if (allowance < amountWei) {
        showToast(`Approving ${tokenMeta.symbol} for betting contract...`, 'info');
        const approveTx = await mclaw.approve(contractAddress, amountWei);
        await approveTx.wait();
      }
      tx = await bettingContract.placeMclawBet(matchIdB32, agentIdB32, amountWei);
    }
    showToast(`Transaction submitted. Waiting for confirmation...`, 'info');

    const receipt = await tx.wait();
    showToast(`You bet ${amountTyped} ${TOKEN_META[tokenUsed].symbol} on ${agentName}`, 'success');

    // Notify backend so it records the bet in DB
    if (window._bettingSocket) {
      window._bettingSocket.emit('humanBetPlaced', {
        matchId: currentMatchId,
        bettorAddress: walletAddress,
        agentName,
        amountWei: amountWei.toString(),
        token: tokenUsed,
        txHash: receipt.hash,
      });
    }

    input.value = '';
    updateWalletUI();
    // Refresh my bets list
    if (currentMatchId) fetchMyBets(currentMatchId);
  } catch (err) {
    console.error('Bet failed:', err);
    const reason = err.reason || err.message || 'Transaction failed';
    showToast('Bet failed: ' + reason, 'error');
  }
};

/* ================================================================
   Claim Winnings
   ================================================================ */
window.claimWinnings = async function claimWinnings() {
  if (!walletAddress || !bettingContract || !currentMatchId) {
    showToast('Connect wallet first', 'error');
    return;
  }

  try {
    showToast('Claiming winnings...', 'info');
    const matchIdB32 = ethers.encodeBytes32String(currentMatchId.length > 31 ? currentMatchId.slice(0, 31) : currentMatchId);
    const tx = await bettingContract.claim(matchIdB32);
    const receipt = await tx.wait();
    showToast('Winnings claimed successfully!', 'success');
    updateWalletUI();

    // Hide claim section
    const claimSection = document.getElementById('claim-section');
    if (claimSection) claimSection.classList.add('hidden');
  } catch (err) {
    console.error('Claim failed:', err);
    showToast('Claim failed: ' + (err.reason || err.message), 'error');
  }
};

/* ================================================================
   My Bets
   ================================================================ */
async function fetchMyBets(matchId) {
  if (!walletAddress) {
    const list = document.getElementById('my-bets-list');
    if (list) list.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">Connect wallet to see your bets</div>';
    return;
  }
  const list = document.getElementById('my-bets-list');
  if (!list) return;

  try {
    // Fetch all bets + stats for this wallet
    const res = await fetch(`/api/betting/bets-by-wallet/${walletAddress}?token=${encodeURIComponent(currentBetToken)}`);
    const data = await res.json();
    const allBets = data.bets || [];
    const stats = data.stats || null;

    // ── Stats banner ──
    let html = '';
    if (stats) {
      const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
      const plColor = stats.isProfit ? '#22c55e' : (stats.profitLoss === '0' ? '#94a3b8' : '#ef4444');
      const plSign = stats.isProfit && stats.profitLoss !== '0' ? '+' : '';
      html += `
        <div class="grid grid-cols-3 gap-2 mb-3">
          <div class="bg-slate-800 border-2 border-white p-2 text-center">
            <div class="text-[9px] font-bold text-slate-400 uppercase">Total Bet</div>
            <div class="text-sm font-black text-[#facc15]">${escHtml(stats.totalBetMON)} ${tokenMeta.symbol}</div>
          </div>
          <div class="bg-slate-800 border-2 border-white p-2 text-center">
            <div class="text-[9px] font-bold text-slate-400 uppercase">Total Won</div>
            <div class="text-sm font-black text-[#22d3ee]">${escHtml(stats.totalPayoutMON)} ${tokenMeta.symbol}</div>
          </div>
          <div class="bg-slate-800 border-2 border-white p-2 text-center">
            <div class="text-[9px] font-bold text-slate-400 uppercase">P&L</div>
            <div class="text-sm font-black" style="color:${plColor}">${plSign}${escHtml(stats.profitLossMON)} ${tokenMeta.symbol}</div>
          </div>
        </div>
        <div class="flex gap-3 mb-3 text-[10px] font-bold text-slate-400">
          <span>${stats.totalBets} bets</span>
          <span>${stats.totalWins} wins</span>
          <span>${stats.matchesPlayed} matches</span>
        </div>
      `;
    }

    if (!allBets.length) {
      html += '<div class="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">No bets placed yet</div>';
      list.innerHTML = html;
      return;
    }

    // ── Bet history grouped by match ──
    const byMatch = {};
    for (const b of allBets) {
      if (!byMatch[b.matchId]) byMatch[b.matchId] = [];
      byMatch[b.matchId].push(b);
    }

    for (const [mId, bets] of Object.entries(byMatch)) {
      const isCurrent = mId === currentMatchId;
      html += `<div class="text-[10px] font-black text-slate-400 uppercase mt-2 mb-1">${escHtml(mId)}${isCurrent ? ' (current)' : ''}</div>`;
      html += bets.map(b => {
        const amtMON = weiToMON(b.amount);
        const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
        return `
          <div class="bg-slate-800 border-2 border-white p-2 flex items-center justify-between">
            <div>
              <span class="text-xs font-black text-[#facc15] uppercase">${escHtml(b.agentName)}</span>
              <span class="text-xs text-slate-400 ml-2">${amtMON} ${tokenMeta.symbol}</span>
            </div>
            ${b.txHash ? `<a href="https://basescan.org/tx/${b.txHash}" target="_blank" class="text-[10px] text-[#22d3ee] font-mono hover:underline">${b.txHash.slice(0,8)}...</a>` : ''}
          </div>
        `;
      }).join('');
    }

    list.innerHTML = html;
  } catch (err) {
    console.error('Failed to fetch my bets:', err);
  }
}

/* ================================================================
   Leaderboard
   ================================================================ */
async function fetchLeaderboard() {
  const container = document.getElementById('betting-leaderboard');
  if (!container) return;

  try {
    const res = await fetch(`/api/betting/leaderboard?token=${encodeURIComponent(currentBetToken)}`);
    const data = await res.json();
    const leaders = data.leaderboard || [];

    if (!leaders.length) {
      container.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-8 bg-slate-800 border-2 border-dashed border-slate-600">No bets placed yet</div>';
      return;
    }

    const tokenMeta = TOKEN_META[currentBetToken] || TOKEN_META.MON;
    container.innerHTML = leaders.slice(0, 20).map((e, i) => {
      const rank = i + 1;
      const rankColors = { 1: '#facc15', 2: '#94a3b8', 3: '#f97316' };
      const color = rankColors[rank] || '#64748b';
      return `
        <div class="bg-slate-800 border-2 border-white p-2 flex items-center gap-3">
          <div class="w-6 h-6 flex items-center justify-center font-black text-xs border-2 border-white" style="background:${color};color:black">${rank}</div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-black text-white truncate">${escHtml(e.bettorName || shortenAddr(e.bettorAddress))}</div>
            <div class="text-[10px] text-slate-400 font-mono">${shortenAddr(e.bettorAddress)}</div>
          </div>
          <div class="text-right">
            <div class="text-xs font-black text-[#facc15]">${e.totalVolumeMON} ${tokenMeta.symbol}</div>
            <div class="text-[10px] text-slate-400">${e.totalBets} bets / ${e.totalWins} wins</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to fetch leaderboard:', err);
  }
}

/* ================================================================
   WebSocket event handlers
   ================================================================ */
function initBettingSocket() {
  // Wait for io to be available (loaded by socket.io script)
  const waitForIo = setInterval(() => {
    if (typeof io === 'undefined') return;
    clearInterval(waitForIo);

    const socket = io();
    window._bettingSocket = socket;

    // Track current match from status events
    socket.on('status', (status) => {
      if (status.currentMatch) {
        const prevMatchId = currentMatchId;
        currentMatchId = status.currentMatch.id;
        // Fetch betting status when match changes or on first load
        if (currentMatchId !== prevMatchId || !currentBettingStatus) {
          fetchBettingStatus(currentMatchId);
        }
      }
    });

    socket.on('lobbyOpen', (data) => {
      currentMatchId = data.matchId;
      // Reset UI
      currentBettingStatus = null;
      const list = document.getElementById('betting-list');
      if (list) list.innerHTML = '<div class="text-center text-sm font-bold text-slate-400 py-10 bg-slate-800 border-2 border-dashed border-slate-600">Waiting for players...</div>';
      const claimSection = document.getElementById('claim-section');
      if (claimSection) claimSection.classList.add('hidden');
    });

    // Betting opening (on-chain not confirmed yet – show agents, no bet button)
    socket.on('bettingPending', (data) => {
      currentMatchId = data.matchId;
      showToast('Opening betting… Place your bet once the panel shows OPEN.', 'info');
      if (data.agentNames && data.agentNames.length) {
        const placeholder = {
          matchId: data.matchId,
          status: 'pending',
          totalPool: '0',
          totalPoolMON: '0',
          agents: data.agentNames.map(name => ({
            agentName: name,
            pool: '0',
            poolMON: '0',
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          })),
          bettorCount: 0,
        };
        currentBettingStatus = placeholder;
        renderBettingUI(placeholder);
      }
      setTimeout(() => fetchBettingStatus(data.matchId), 500);
    });

    // Betting opened on-chain – users can place bets
    socket.on('bettingOpen', (data) => {
      currentMatchId = data.matchId;
      showToast(`Betting is open for ${data.matchId}!`, 'info');
      if (data.agentNames && data.agentNames.length) {
        const placeholder = {
          matchId: data.matchId,
          status: 'open',
          totalPool: '0',
          totalPoolMON: '0',
          agents: data.agentNames.map(name => ({
            agentName: name,
            pool: '0',
            poolMON: '0',
            percentage: 0,
            multiplier: 0,
            bettorCount: 0,
          })),
          bettorCount: 0,
        };
        currentBettingStatus = placeholder;
        renderBettingUI(placeholder);
      }
      setTimeout(() => fetchBettingStatus(data.matchId), 500);
    });

    // New agent joined the pool (lobby)
    socket.on('bettingAgentsUpdate', (data) => {
      if (data.matchId === currentMatchId && data.agentNames) {
        // Refresh the betting status to include the new agent
        fetchBettingStatus(data.matchId);
      }
    });

    // Real-time odds update (after every bet)
    socket.on('bettingUpdate', (status) => {
      // Ignore updates for a different token than the one currently selected
      if (status.token && status.token !== currentBetToken) {
        return;
      }
      currentBettingStatus = status;
      renderBettingUI(status);
    });

    // Individual bet placed (for toasts)
    socket.on('betPlaced', (data) => {
      // Don't toast our own bets (already handled)
      if (walletAddress && data.bettorAddress === walletAddress.toLowerCase()) return;
      const name = data.bettorName || shortenAddr(data.bettorAddress);
      const tokenMeta = TOKEN_META[data.token || 'MON'] || TOKEN_META.MON;
      showToast(`${name} bet ${data.amountMON} ${tokenMeta.symbol} on ${data.agentName}`, 'neutral');
    });

    // Betting closed
    socket.on('bettingClosed', (data) => {
      showToast('Betting is now locked! Match starting soon...', 'info');
      if (data.matchId === currentMatchId) fetchBettingStatus(currentMatchId);
    });

    // Betting resolved
    socket.on('bettingResolved', (data) => {
      const msg = data.isDraw
        ? `Draw! ${data.winners.join(' & ')} tied. Pool: ${data.totalPoolMON} MON`
        : `${data.winners[0]} wins! Pool: ${data.totalPoolMON} MON`;
      showToast(msg, 'success');

      if (data.matchId === currentMatchId) {
        fetchBettingStatus(currentMatchId);
      }

      // Winnings are now auto-distributed by the server, no manual claim needed.
      // But still check after a delay in case auto-distribution hasn't completed yet.
      if (walletAddress && bettingContract && data.matchId) {
        setTimeout(() => checkClaimable(data.matchId), 10000);
      }
    });

    // Auto-distribution: server sends winnings directly to winners
    socket.on('winningsDistributed', (data) => {
      if (walletAddress && data.bettorAddress === walletAddress.toLowerCase()) {
        showToast(`You won ${data.payoutMON} MON! Auto-sent to your wallet.`, 'success');
        updateWalletUI();
        // Hide claim section since it was auto-claimed
        const claimSection = document.getElementById('claim-section');
        if (claimSection) claimSection.classList.add('hidden');
      }
    });
  }, 200);
}

async function checkClaimable(matchId) {
  if (!bettingContract || !walletAddress) return;
  try {
    const matchIdB32 = ethers.encodeBytes32String(matchId.length > 31 ? matchId.slice(0, 31) : matchId);
    const res = await bettingContract.getClaimableAmounts(matchIdB32, walletAddress);
    const monAmount = res[0];
    const mclawAmount = res[1];
    const total = (monAmount || 0n) + (mclawAmount || 0n);
    if (total > 0n) {
      const parts = [];
      if (monAmount && monAmount > 0n) parts.push(parseFloat(ethers.formatEther(monAmount)).toFixed(4) + ' MON');
      if (mclawAmount && mclawAmount > 0n) parts.push(parseFloat(ethers.formatEther(mclawAmount)).toFixed(4) + ' MClawIO');
      const label = parts.join(' + ');
      const claimSection = document.getElementById('claim-section');
      const claimAmount = document.getElementById('claimable-amount');
      if (claimSection) claimSection.classList.remove('hidden');
      if (claimAmount) claimAmount.textContent = label;
      showToast(`You won ${label}! Claim now.`, 'gold');
    }
  } catch (err) {
    console.error('checkClaimable failed:', err);
  }
}

/* ================================================================
   Toast Notification System
   ================================================================ */
const MAX_TOASTS = 3;
const TOAST_DURATION = 5000;

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Limit visible toasts
  while (container.children.length >= MAX_TOASTS) {
    container.removeChild(container.firstChild);
  }

  const colors = {
    success: 'bg-[#a3e635] text-black border-white',
    error:   'bg-red-500 text-white border-white',
    info:    'bg-[#22d3ee] text-black border-white',
    neutral: 'bg-slate-700 text-white border-slate-500',
    gold:    'bg-[#facc15] text-black border-white',
  };
  const icons = {
    success: '&#10003;',
    error:   '&#10007;',
    info:    '&#9432;',
    neutral: '&#8226;',
    gold:    '&#9733;',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${colors[type] || colors.info} border-2 shadow-[3px_3px_0_black] px-4 py-3 flex items-start gap-2 cursor-pointer`;
  toast.innerHTML = `
    <span class="font-black text-sm flex-shrink-0">${icons[type] || icons.info}</span>
    <span class="text-xs font-bold flex-1">${escHtml(message)}</span>
  `;
  toast.onclick = () => dismissToast(toast);
  container.appendChild(toast);

  // Auto-dismiss
  setTimeout(() => dismissToast(toast), TOAST_DURATION);
}

function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.add('toast-exit');
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
}

/* ================================================================
   Utilities
   ================================================================ */
function shortenAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return escHtml(s).replace(/'/g, '&#39;');
}

function weiToMON(wei) {
  try {
    const n = BigInt(wei);
    const whole = n / 1000000000000000000n;
    const frac = n % 1000000000000000000n;
    const fracStr = frac.toString().padStart(18, '0').slice(0, 4);
    return fracStr.replace(/0+$/, '') ? `${whole}.${fracStr.replace(/0+$/, '')}` : whole.toString();
  } catch {
    return '0';
  }
}

// Make showToast globally available for other scripts
window.showToast = showToast;

/* ================================================================
   Init
   ================================================================ */
initBettingSocket();
