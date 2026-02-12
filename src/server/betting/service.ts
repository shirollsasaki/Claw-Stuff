/**
 * Betting service – business logic layer between the API / match lifecycle
 * and the on-chain ClawBetting contract.  All state is persisted to Postgres.
 */
import { dbQuery, getGlobalLeaderboard } from '../db.js';
import * as chain from './contract.js';

// ── Types ──────────────────────────────────────────────────────────────

export type Token = 'MON' | 'MCLAW';

export interface AgentOdds {
   agentName: string;
   pool: string;          // wei string
   poolMON: string;       // human-readable ETH
   percentage: number;    // 0-100
   multiplier: number;    // e.g. 2.4 = 2.4x return per 1 ETH
   bettorCount: number;
   winRate?: number;      // historical win rate (0-1, e.g. 0.7 = 70%)
 }

export interface BettingStatus {
  matchId: string;
  status: 'pending' | 'open' | 'closed' | 'resolved' | 'cancelled' | 'none';
  token: Token;
  totalPool: string;
  totalPoolMON: string;
  agents: AgentOdds[];
  bettorCount: number;
}

export interface BetRecord {
  id: number;
  matchId: string;
  bettorAddress: string;
  bettorType: string;
  bettorName: string | null;
  agentName: string;
  amount: string;
  token: Token;
  txHash: string | null;
  placedAt: string;
}

export interface LeaderboardEntry {
  bettorAddress: string;
  bettorName: string | null;
  totalVolume: string;
  totalVolumeMON: string;
  totalBets: number;
  totalWins: number;
  totalPayout: string;
}

// Callback type for WebSocket emission
type BettingEmitter = (event: string, data: any) => void;
let emitter: BettingEmitter | null = null;

export function setEmitter(fn: BettingEmitter) {
  emitter = fn;
}

function emit(event: string, data: any) {
  if (emitter) emitter(event, data);
}

// ── Helpers ────────────────────────────────────────────────────────────

function weiToMON(wei: string): string {
  try {
    const n = BigInt(wei);
    const whole = n / 1000000000000000000n;
    const frac = n % 1000000000000000000n;
    const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return '0';
  }
}

// ── Core service functions ─────────────────────────────────────────────

/**
 * Called when a lobby has 2+ players and betting should open.
 * @param sendOnChain – if false, only set DB to 'pending' + emit bettingPending (UI shows agents, no bet yet).
 *                      if true, send openBetting tx on-chain, then set 'open' and emit bettingOpen only after confirm.
 */
export async function openBettingForMatch(matchId: string, agentNames: string[], sendOnChain: boolean = true) {
  // Never set DB to 'open' until on-chain openBetting has confirmed (so UI never shows "Bet" too early)
  try {
    await dbQuery(
      `INSERT INTO betting_pools (match_id, status, agent_names)
       VALUES ($1, 'pending', $2)
       ON CONFLICT (match_id) DO UPDATE SET status = 'pending', agent_names = $2`,
      [matchId, agentNames],
    );
  } catch (err) {
    console.error('[betting/service] DB openBettingForMatch failed:', err);
  }

  if (sendOnChain) {
    try {
      await chain.openBetting(matchId, agentNames);
      // Only after on-chain open is confirmed: set DB 'open' and tell clients they can bet
      await dbQuery(
        `UPDATE betting_pools SET status = 'open', agent_names = $2 WHERE match_id = $1`,
        [matchId, agentNames],
      );
      emit('bettingOpen', {
        matchId,
        agentNames,
        contractAddress: chain.getContractAddress(),
        chainInfo: chain.getChainInfo(),
      });
    } catch (err) {
      console.error('[betting/service] openBetting chain call failed:', err);
    }
  } else {
    emit('bettingPending', {
      matchId,
      agentNames,
      contractAddress: chain.getContractAddress(),
      chainInfo: chain.getChainInfo(),
    });
  }
}

/**
 * Add a single agent to an open betting pool (called when a new player joins lobby).
 * Updates both the DB and the on-chain contract.
 */
export async function addBettingAgent(matchId: string, agentName: string) {
  try {
    const result = await dbQuery<{ agent_names: string[] }>(
      `UPDATE betting_pools
       SET agent_names = CASE
         WHEN agent_names IS NULL THEN ARRAY[$2::text]
         WHEN NOT ($2 = ANY(agent_names)) THEN array_append(agent_names, $2)
         ELSE agent_names
       END
       WHERE match_id = $1 AND status = 'open'
       RETURNING agent_names`,
      [matchId, agentName],
    );
    const updatedNames = result[0]?.agent_names || [];
    // Emit update so the frontend renders the new agent cards
    emit('bettingAgentsUpdate', { matchId, agentNames: updatedNames });
  } catch (err) {
    console.error('[betting/service] DB addBettingAgent failed:', err);
  }

  // On-chain: enqueued inside contract.ts global tx queue (runs after openBetting)
  chain.addAgents(matchId, [agentName]).catch(err =>
    console.error('[betting/service] addAgents chain call failed:', err),
  );
}

/**
 * Place a bet (called for both humans via frontend events and agents via API).
 * For humans and self-funded agents the tx is already on-chain and we just
 * record it in the DB.
 */
export async function placeBet(opts: {
  bettorAddress: string;
  bettorType: 'human' | 'agent';
  bettorName: string | null;
  matchId: string;
  agentName: string;
   amountWei: string;
   token?: Token;      // ETH (default) or MCLAW
   txHash?: string;    // already have a tx hash (human placed directly)
}): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const {
    bettorAddress,
    bettorType,
    bettorName,
    matchId,
    agentName,
    amountWei,
    token = 'MON',
    txHash,
  } = opts;

  // Validate pool exists and is in a valid state for recording bets
  const poolRows = await dbQuery<{ status: string }>(
    `SELECT status FROM betting_pools WHERE match_id = $1`,
    [matchId],
  );
  if (!poolRows.length) {
    return { success: false, error: 'No betting pool for this match' };
  }
  const poolStatus = poolRows[0].status;
  // For externally-funded bets that already have a txHash (confirmed on-chain),
  // accept even if the DB status is 'closed' — the contract accepted the bet
  // before closeBetting was mined, so the money is in the pool and must be tracked.
  const isConfirmedExternalBet = !!txHash;
  if (poolStatus !== 'open' && !(isConfirmedExternalBet && poolStatus === 'closed')) {
    return { success: false, error: 'Betting is not open for this match' };
  }

  let finalTxHash = txHash || null;

  // Agents must self-fund bets from their own wallet; this service only records
  // already-mined transactions. Humans may or may not provide a txHash
  // depending on the integration, but agents are required to.
  if (bettorType === 'agent' && !finalTxHash) {
    return { success: false, error: 'Agent bets must be self-funded and include txHash (use /api/betting/place-bet-direct).' };
  }

  // Record bet in DB
  try {
    await dbQuery(
      `INSERT INTO bets (match_id, bettor_address, bettor_type, bettor_name, agent_name, amount, tx_hash, token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [matchId, bettorAddress.toLowerCase(), bettorType, bettorName, agentName, amountWei, finalTxHash, token],
    );

    // For backwards compatibility, keep betting_pools.total_pool as MON-only.
    if (token === 'MON') {
      await dbQuery(
        `UPDATE betting_pools SET total_pool = total_pool + $2 WHERE match_id = $1`,
        [matchId, amountWei],
      );
    }

    // Update leaderboard
    await updateLeaderboard(bettorAddress, bettorName, amountWei, token);
  } catch (err) {
    console.error('[betting/service] DB placeBet failed:', err);
  }

  // Emit real-time update
  const status = await getBettingStatus(matchId, token);
  emit('bettingUpdate', status);
  emit('betPlaced', {
    matchId,
    bettorAddress: bettorAddress.toLowerCase(),
    bettorName,
    bettorType,
    agentName,
    amount: amountWei,
    amountMON: weiToMON(amountWei),
    token,
  });

  return { success: true, txHash: finalTxHash || undefined };
}

/**
 * Called when match starts (or slightly before) – lock bets.
 * Idempotent: calling twice for the same match is safe.
 */
export async function closeBettingForMatch(matchId: string) {
  // Only close if currently open (avoid double-close on-chain)
  const poolRows = await dbQuery<{ status: string }>(
    `SELECT status FROM betting_pools WHERE match_id = $1`,
    [matchId],
  );
  if (!poolRows.length || poolRows[0].status !== 'open') return;

  try {
    await dbQuery(
      `UPDATE betting_pools SET status = 'closed' WHERE match_id = $1 AND status = 'open'`,
      [matchId],
    );
  } catch (err) {
    console.error('[betting/service] DB closeBettingForMatch failed:', err);
  }

  // On-chain: enqueued inside contract.ts global tx queue (runs after openBetting/addAgents)
  chain.closeBetting(matchId).catch(err =>
    console.error('[betting/service] closeBetting chain call failed:', err),
  );

  emit('bettingClosed', { matchId });
}

/**
 * Called when match ends. Handles single winner, draw, and no-bets-on-winner.
 */
export async function resolveMatchBetting(opts: {
  matchId: string;
  winnerAgentNames: string[];
  winnerAgentWallets: string[];  // same length, address(0) if unknown
  isDraw: boolean;
}) {
  const { matchId, winnerAgentNames, winnerAgentWallets, isDraw } = opts;

  // Check if there is a pool at all
  const poolRows = await dbQuery<{ total_pool: string; status: string }>(
    `SELECT total_pool, status FROM betting_pools WHERE match_id = $1`,
    [matchId],
  );
  if (!poolRows.length) {
    console.log(`[betting/service] No betting pool for ${matchId}, skipping`);
    return;
  }

  const pool = poolRows[0];
  if (pool.status !== 'closed' && pool.status !== 'open') {
    console.log(`[betting/service] Pool ${matchId} status is ${pool.status}, skipping`);
    return;
  }

  // If pool was still open (match started too fast / edge case), close it first
  if (pool.status === 'open') {
    await closeBettingForMatch(matchId);
  }

  const totalPool = BigInt(pool.total_pool || '0');
  if (totalPool === 0n) {
    // Nothing wagered – just mark resolved
    await dbQuery(
      `UPDATE betting_pools SET status = 'resolved', winner_agent_names = $2, is_draw = $3, resolved_at = NOW()
       WHERE match_id = $1`,
      [matchId, winnerAgentNames, isDraw],
    );
    emit('bettingResolved', { matchId, totalPool: '0', totalPoolMON: '0', winners: winnerAgentNames, isDraw, noBetsOnWinner: false, payoutMultiplier: 0 });
    return;
  }

  // Resolve on-chain
  const txHash = await chain.resolveMatch(matchId, winnerAgentNames, winnerAgentWallets);

  // Calculate payouts for DB record
  const treasuryAmount = (totalPool * 500n) / 10000n;
  const agentAmount = (totalPool * 500n) / 10000n;

  // Check if anyone bet on winners
  const winnerBetsRows = await dbQuery<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM bets
     WHERE match_id = $1 AND agent_name = ANY($2)`,
    [matchId, winnerAgentNames],
  );
  const combinedWinnerPool = BigInt(winnerBetsRows[0]?.total || '0');
  const noBetsOnWinner = combinedWinnerPool === 0n;

  const actualTreasury = noBetsOnWinner ? totalPool - agentAmount : treasuryAmount;

  // Calculate payout multiplier for display
  const bettorPoolAmount = noBetsOnWinner ? 0n : (totalPool * 9000n) / 10000n;
  const payoutMultiplier = combinedWinnerPool > 0n
    ? Number(bettorPoolAmount * 1000n / combinedWinnerPool) / 1000
    : 0;

  // Update DB
  try {
    await dbQuery(
      `UPDATE betting_pools SET
        status = 'resolved',
        winner_agent_names = $2,
        winner_agent_wallets = $3,
        is_draw = $4,
        treasury_payout = $5,
        agent_payout = $6,
        resolve_tx_hash = $7,
        resolved_at = NOW()
       WHERE match_id = $1`,
      [matchId, winnerAgentNames, winnerAgentWallets, isDraw,
       actualTreasury.toString(), agentAmount.toString(), txHash],
    );
  } catch (err) {
    console.error('[betting/service] DB resolveMatchBetting failed:', err);
  }

  emit('bettingResolved', {
    matchId,
    totalPool: totalPool.toString(),
    totalPoolMON: weiToMON(totalPool.toString()),
    winners: winnerAgentNames,
    isDraw,
    noBetsOnWinner,
    payoutMultiplier,
  });

  // ── Auto-distribute winnings to all winning bettors ──
  if (!noBetsOnWinner) {
    autoDistributeWinnings(matchId, winnerAgentNames).catch(err =>
      console.error('[betting/service] autoDistributeWinnings failed:', err),
    );
  }
}

/**
 * Claim winnings (backend calls claimFor on-chain for agents).
 */
export async function claimWinnings(
  bettorAddress: string,
  matchId: string,
): Promise<{ success: boolean; txHashMon?: string; txHashMclaw?: string; payoutMon?: string; payoutMclaw?: string; error?: string }> {
   // Check claimable amounts from contract (ETH and MCLAW)
  const { monAmount, mclawAmount } = await chain.getClaimableAmounts(matchId, bettorAddress);
  const hasMon = monAmount !== '0';
  const hasMclaw = mclawAmount !== '0';

  if (!hasMon && !hasMclaw) {
    return { success: false, error: 'Nothing to claim' };
  }

  let txHashMon: string | undefined;
  let txHashMclaw: string | undefined;

   // Claim ETH (via operator) if any
  if (hasMon) {
    txHashMon = await chain.claimFor(bettorAddress, matchId) || undefined;
    if (txHashMon) {
      try {
        await dbQuery(
          `INSERT INTO bet_settlements (match_id, bettor_address, payout_amount, claim_tx_hash, token)
           VALUES ($1, $2, $3, $4, $5)`,
          [matchId, bettorAddress.toLowerCase(), monAmount, txHashMon, 'MON'],
        );
        await dbQuery(
          `UPDATE betting_leaderboard SET
             total_wins = total_wins + 1,
             total_payout = total_payout + $2
           WHERE bettor_address = $1`,
          [bettorAddress.toLowerCase(), monAmount],
        );
      } catch (err) {
        console.error('[betting/service] DB claimWinnings MON failed:', err);
      }
    }
  }

  // Claim MCLAW (via operator) if any
  if (hasMclaw) {
    txHashMclaw = await chain.claimMclawFor(bettorAddress, matchId) || undefined;
    if (txHashMclaw) {
      try {
        await dbQuery(
          `INSERT INTO bet_settlements (match_id, bettor_address, payout_amount, claim_tx_hash, token)
           VALUES ($1, $2, $3, $4, $5)`,
          [matchId, bettorAddress.toLowerCase(), mclawAmount, txHashMclaw, 'MCLAW'],
        );
        await dbQuery(
          `UPDATE betting_leaderboard SET
             total_wins = total_wins + 1,
             total_payout = total_payout + $2
           WHERE bettor_address = $1`,
          [bettorAddress.toLowerCase(), mclawAmount],
        );
      } catch (err) {
        console.error('[betting/service] DB claimWinnings MCLAW failed:', err);
      }
    }
  }

  if (!txHashMon && !txHashMclaw) {
    return { success: false, error: 'Claim transaction failed' };
  }

  return {
    success: true,
    txHashMon,
    txHashMclaw,
    payoutMon: hasMon ? monAmount : undefined,
    payoutMclaw: hasMclaw ? mclawAmount : undefined,
  };
}

/**
 * Automatically distribute winnings to all bettors who bet on winning agents.
 * Called after resolveMatch – claims on behalf of each winner via the operator wallet.
 */
async function autoDistributeWinnings(matchId: string, winnerAgentNames: string[]) {
  // Get all unique bettor addresses that bet on any winning agent (any token)
  const winningBettors = await dbQuery<{ bettor_address: string }>(
    `SELECT DISTINCT bettor_address FROM bets
     WHERE match_id = $1 AND agent_name = ANY($2)`,
    [matchId, winnerAgentNames],
  );

  if (!winningBettors.length) return;

  console.log(`[betting/service] Auto-distributing winnings for ${matchId} to ${winningBettors.length} winner(s)...`);

  for (const row of winningBettors) {
    const addr = row.bettor_address;
    try {
      const { monAmount, mclawAmount } = await chain.getClaimableAmounts(matchId, addr);
      const hasMon = monAmount !== '0';
      const hasMclaw = mclawAmount !== '0';
      if (!hasMon && !hasMclaw) {
        console.log(`[betting/service] ${addr} has nothing to claim for ${matchId}, skipping`);
        continue;
      }

      // Claim MON if any
      if (hasMon) {
        const txHashMon = await chain.claimFor(addr, matchId);
        if (!txHashMon) {
          console.error(`[betting/service] claimFor(${addr}, ${matchId}) MON tx failed`);
        } else {
          console.log(`[betting/service] Auto-claimed ${weiToMON(monAmount)} MON for ${addr} (tx: ${txHashMon})`);
          try {
            await dbQuery(
              `INSERT INTO bet_settlements (match_id, bettor_address, payout_amount, claim_tx_hash, token)
               VALUES ($1, $2, $3, $4, $5)`,
              [matchId, addr, monAmount, txHashMon, 'MON'],
            );
            await dbQuery(
              `UPDATE betting_leaderboard SET
                 total_wins = total_wins + 1,
                 total_payout = total_payout + $2
               WHERE bettor_address = $1`,
              [addr, monAmount],
            );
          } catch (dbErr) {
            console.error(`[betting/service] DB settlement record failed for ${addr} (MON):`, dbErr);
          }

          emit('winningsDistributed', {
            matchId,
            bettorAddress: addr,
            payout: monAmount,
            payoutMON: weiToMON(monAmount),
            txHash: txHashMon,
            token: 'MON',
          });
        }
      }

      // Claim MCLAW if any
      if (hasMclaw) {
        const txHashMclaw = await chain.claimMclawFor(addr, matchId);
        if (!txHashMclaw) {
          console.error(`[betting/service] claimMclawFor(${addr}, ${matchId}) MCLAW tx failed`);
        } else {
          console.log(`[betting/service] Auto-claimed ${weiToMON(mclawAmount)} MCLAW for ${addr} (tx: ${txHashMclaw})`);
          try {
            await dbQuery(
              `INSERT INTO bet_settlements (match_id, bettor_address, payout_amount, claim_tx_hash, token)
               VALUES ($1, $2, $3, $4, $5)`,
              [matchId, addr, mclawAmount, txHashMclaw, 'MCLAW'],
            );
            await dbQuery(
              `UPDATE betting_leaderboard SET
                 total_wins = total_wins + 1,
                 total_payout = total_payout + $2
               WHERE bettor_address = $1`,
              [addr, mclawAmount],
            );
          } catch (dbErr) {
            console.error(`[betting/service] DB settlement record failed for ${addr} (MCLAW):`, dbErr);
          }

          emit('winningsDistributed', {
            matchId,
            bettorAddress: addr,
            payout: mclawAmount,
            payoutMON: weiToMON(mclawAmount),
            txHash: txHashMclaw,
            token: 'MCLAW',
          });
        }
      }
    } catch (err) {
      console.error(`[betting/service] autoDistribute for ${addr} failed:`, err);
    }
  }

  console.log(`[betting/service] Auto-distribution complete for ${matchId}`);
}

/**
 * Get betting status with live odds for each agent.
 */
export async function getBettingStatus(matchId: string, token: Token = 'MON'): Promise<BettingStatus> {
  // agent_names and base status still come from betting_pools (match-level metadata)
  const poolRows = await dbQuery<{ status: string; agent_names: string[] | null }>(
    `SELECT status, agent_names FROM betting_pools WHERE match_id = $1`,
    [matchId],
  );

  if (!poolRows.length) {
    return { matchId, status: 'none', token, totalPool: '0', totalPoolMON: '0', agents: [], bettorCount: 0 };
  }

  const { status, agent_names } = poolRows[0];

  // Compute total pool per token from bets table (source of truth for multi-token)
  const totalPoolRows = await dbQuery<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM bets WHERE match_id = $1 AND token = $2`,
    [matchId, token],
  );
  const totalPool = BigInt(totalPoolRows[0]?.total || '0');
  const allAgentNames: string[] = agent_names || [];

  // Fallback: merge in agents from the contract (in case DB had a race and only has 2)
  let contractAgentNames: string[] = [];
  try {
    const contractStatus = await chain.getMatchStatus(matchId);
    if (contractStatus?.agentIds?.length) contractAgentNames = contractStatus.agentIds;
  } catch {
    // ignore
  }

  // Per-agent pools and bettor counts (from actual bets)
  const agentRows = await dbQuery<{ agent_name: string; pool: string; bettors: string }>(
    `SELECT agent_name, SUM(amount)::text AS pool, COUNT(DISTINCT bettor_address)::text AS bettors
     FROM bets WHERE match_id = $1 AND token = $2 GROUP BY agent_name`,
    [matchId, token],
  );

  // Build a map of agent bet data
  const betDataMap = new Map<string, { pool: bigint; bettorCount: number }>();
  for (const row of agentRows) {
    betDataMap.set(row.agent_name, {
      pool: BigInt(row.pool),
      bettorCount: parseInt(row.bettors, 10),
    });
  }

  // Global leaderboard win rates (matches, wins, winRate per agent)
  const winRateMap = new Map<string, number>();
  try {
    const leaderboard = await getGlobalLeaderboard();
    for (const row of leaderboard.leaderboard) {
      winRateMap.set(row.agentName, row.winRate);
    }
  } catch {
    // If global leaderboard is unavailable, we just omit winRate
  }

  // Merge: show ALL agents (DB + contract + any with bets)
  const agentSet = new Set<string>([...allAgentNames, ...contractAgentNames, ...betDataMap.keys()]);
  const agents: AgentOdds[] = Array.from(agentSet).map((agentName) => {
    const data = betDataMap.get(agentName);
    const agentPool = data?.pool ?? 0n;
    const percentage = totalPool > 0n ? Number((agentPool * 10000n) / totalPool) / 100 : 0;
    const multiplier = agentPool > 0n
      ? Number((totalPool * 9000n * 1000n) / (10000n * agentPool)) / 1000
      : 0;
    return {
      agentName,
      pool: agentPool.toString(),
      poolMON: weiToMON(agentPool.toString()),
      percentage,
      multiplier,
      bettorCount: data?.bettorCount ?? 0,
      winRate: winRateMap.get(agentName),
    };
  });

  const totalBettorRows = await dbQuery<{ cnt: string }>(
    `SELECT COUNT(DISTINCT bettor_address)::text AS cnt FROM bets WHERE match_id = $1 AND token = $2`,
    [matchId, token],
  );
  const bettorCount = parseInt(totalBettorRows[0]?.cnt || '0', 10);

  return {
    matchId,
    status: status as BettingStatus['status'],
    token,
    totalPool: totalPool.toString(),
    totalPoolMON: weiToMON(totalPool.toString()),
    agents,
    bettorCount,
  };
}

/**
 * Get a user's bets, optionally filtered by match and token.
 */
export async function getUserBets(
  bettorAddress: string,
  matchId?: string,
  token?: Token,
): Promise<BetRecord[]> {
  const addr = bettorAddress.toLowerCase();
  let rows: any[];
  if (matchId) {
    if (token) {
      rows = await dbQuery(
        `SELECT * FROM bets WHERE bettor_address = $1 AND match_id = $2 AND token = $3 ORDER BY placed_at DESC`,
        [addr, matchId, token],
      );
    } else {
      rows = await dbQuery(
        `SELECT * FROM bets WHERE bettor_address = $1 AND match_id = $2 ORDER BY placed_at DESC`,
        [addr, matchId],
      );
    }
  } else {
    if (token) {
      rows = await dbQuery(
        `SELECT * FROM bets WHERE bettor_address = $1 AND token = $2 ORDER BY placed_at DESC LIMIT 100`,
        [addr, token],
      );
    } else {
      rows = await dbQuery(
        `SELECT * FROM bets WHERE bettor_address = $1 ORDER BY placed_at DESC LIMIT 100`,
        [addr],
      );
    }
  }

  return rows.map((r: any) => ({
    id: r.id,
    matchId: r.match_id,
    bettorAddress: r.bettor_address,
    bettorType: r.bettor_type,
    bettorName: r.bettor_name,
    agentName: r.agent_name,
    amount: r.amount,
    token: r.token,
    txHash: r.tx_hash,
    placedAt: r.placed_at,
  }));
}

/**
 * Get aggregate stats for a wallet: total bet, total payout, profit/loss, win count.
 * Optionally filtered by token.
 */
export async function getWalletStats(bettorAddress: string, token?: Token) {
  const addr = bettorAddress.toLowerCase();

  // Total wagered
  const betRows = await dbQuery<{ total: string; cnt: string }>(
    token
      ? `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::text AS cnt
         FROM bets WHERE bettor_address = $1 AND token = $2`
      : `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::text AS cnt
         FROM bets WHERE bettor_address = $1`,
    token ? [addr, token] : [addr],
  );
  const totalBetWei = betRows[0]?.total || '0';
  const totalBets = parseInt(betRows[0]?.cnt || '0', 10);

  // Total payouts received
  const payoutRows = await dbQuery<{ total: string; cnt: string }>(
    token
      ? `SELECT COALESCE(SUM(payout_amount), 0)::text AS total, COUNT(*)::text AS cnt
         FROM bet_settlements WHERE bettor_address = $1 AND token = $2`
      : `SELECT COALESCE(SUM(payout_amount), 0)::text AS total, COUNT(*)::text AS cnt
         FROM bet_settlements WHERE bettor_address = $1`,
    token ? [addr, token] : [addr],
  );
  const totalPayoutWei = payoutRows[0]?.total || '0';
  const totalWins = parseInt(payoutRows[0]?.cnt || '0', 10);

  // Matches participated in
  const matchRows = await dbQuery<{ cnt: string }>(
    token
      ? `SELECT COUNT(DISTINCT match_id)::text AS cnt FROM bets WHERE bettor_address = $1 AND token = $2`
      : `SELECT COUNT(DISTINCT match_id)::text AS cnt FROM bets WHERE bettor_address = $1`,
    token ? [addr, token] : [addr],
  );
  const matchesPlayed = parseInt(matchRows[0]?.cnt || '0', 10);

  const totalBet = BigInt(totalBetWei);
  const totalPayout = BigInt(totalPayoutWei);
  const profitLoss = totalPayout - totalBet;

  return {
    totalBet: totalBetWei,
    totalBetMON: weiToMON(totalBetWei),
    totalPayout: totalPayoutWei,
    totalPayoutMON: weiToMON(totalPayoutWei),
    profitLoss: profitLoss.toString(),
    profitLossMON: (profitLoss >= 0n ? '' : '-') + weiToMON((profitLoss >= 0n ? profitLoss : -profitLoss).toString()),
    isProfit: profitLoss >= 0n,
    totalBets,
    totalWins,
    matchesPlayed,
  };
}

/**
 * Get match betting history (all bets + settlements).
 */
export async function getMatchHistory(matchId: string) {
  const bets = await dbQuery(
    `SELECT * FROM bets WHERE match_id = $1 ORDER BY placed_at ASC`,
    [matchId],
  );

  const settlements = await dbQuery(
    `SELECT * FROM bet_settlements WHERE match_id = $1 ORDER BY settled_at ASC`,
    [matchId],
  );

  const pool = await dbQuery(
    `SELECT * FROM betting_pools WHERE match_id = $1`,
    [matchId],
  );

  return { pool: pool[0] || null, bets, settlements };
}

/**
 * Get betting leaderboard ranked by total volume.
 */
export async function getLeaderboard(limit: number = 50, token?: Token): Promise<LeaderboardEntry[]> {
  const rows = await dbQuery<any>(
    token
      ? `SELECT * FROM betting_leaderboard WHERE token = $2 ORDER BY total_volume DESC LIMIT $1`
      : `SELECT * FROM betting_leaderboard ORDER BY total_volume DESC LIMIT $1`,
    token ? [limit, token] : [limit],
  );

  return rows.map((r: any) => ({
    bettorAddress: r.bettor_address,
    bettorName: r.bettor_name,
    totalVolume: r.total_volume,
    totalVolumeMON: weiToMON(r.total_volume),
    totalBets: parseInt(r.total_bets, 10),
    totalWins: parseInt(r.total_wins, 10),
    totalPayout: r.total_payout,
  }));
}

/**
 * Register an agent's wallet address.
 *
 * Uses BOTH the agent's canonical name and its API key to avoid
 * collisions when multiple agents share the same display name.
 */
export async function registerAgentWallet(agentName: string, apiKey: string, walletAddress: string) {
  try {
    const rows = await dbQuery(
      `UPDATE agents SET wallet_address = $3 WHERE name = $1 AND api_key = $2`,
      [agentName, apiKey, walletAddress.toLowerCase()],
    );
    // If no rows were updated, either the agent row doesn't exist yet
    // (no games played) or there is a name/api_key mismatch.
    if (!rows) {
      // dbQuery already returns rows; for UPDATE we don't get affected row count.
      // Log a soft warning and still return true to avoid blocking gameplay.
      console.warn('[betting/service] registerAgentWallet: no matching agent row for', agentName);
    }
    return true;
  } catch (err) {
    console.error('[betting/service] registerAgentWallet failed:', err);
    return false;
  }
}

/**
 * Get agent's registered wallet address.
 *
 * Uses BOTH the agent's canonical name and its API key to avoid
 * collisions when multiple agents share the same display name.
 */
export async function getAgentWallet(agentName: string, apiKey: string): Promise<string | null> {
  const rows = await dbQuery<{ wallet_address: string | null }>(
    `SELECT wallet_address FROM agents WHERE name = $1 AND api_key = $2`,
    [agentName, apiKey],
  );
  return rows[0]?.wallet_address || null;
}

// ── Internal helpers ───────────────────────────────────────────────────

async function updateLeaderboard(bettorAddress: string, bettorName: string | null, amountWei: string, token: Token) {
  try {
    await dbQuery(
      `INSERT INTO betting_leaderboard (bettor_address, token, bettor_name, total_volume, total_bets, last_bet_at)
       VALUES ($1, $4, $2, $3, 1, NOW())
       ON CONFLICT (bettor_address, token) DO UPDATE SET
         bettor_name = COALESCE($2, betting_leaderboard.bettor_name),
         total_volume = betting_leaderboard.total_volume + $3,
         total_bets = betting_leaderboard.total_bets + 1,
         last_bet_at = NOW()`,
      [bettorAddress.toLowerCase(), bettorName, amountWei, token],
    );
  } catch (err) {
    console.error('[betting/service] updateLeaderboard failed:', err);
  }
}
