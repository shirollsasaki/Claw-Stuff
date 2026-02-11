/**
 * REST API routes for the prediction market / betting system.
 * Mounted at /api/betting
 */
import { Router, Request, Response } from 'express';
import { verifyAgentApiKey, createTestAgent } from '../api/auth.js';
import * as bettingService from './service.js';
import { getContractAddress, getContractABI, getChainInfo, isConfigured } from './contract.js';
import { config } from '../config.js';

const DEV_MODE = process.env.NODE_ENV !== 'production';

export function createBettingRoutes(): Router {
  const router = Router();
  const ensureBettingEnabled = (res: Response): boolean => {
    if (!config.bettingEnabled) {
      res.status(503).json({ error: 'Betting is temporarily disabled' });
      return false;
    }
    return true;
  };

  // ── Helper: extract API key ──────────────────────────────────────────
  const extractApiKey = (req: Request): string | null => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
  };

  // ── Helper: authenticate agent ───────────────────────────────────────
  const authenticateAgent = async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) {
      res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Missing Authorization header' });
      return null;
    }
    let agentInfo;
    if (DEV_MODE && apiKey.startsWith('test_')) {
      agentInfo = createTestAgent(apiKey.replace('test_', ''));
    } else {
      agentInfo = await verifyAgentApiKey(apiKey);
    }
    if (!agentInfo) {
      res.status(401).json({ success: false, error: 'INVALID_API_KEY', message: 'Invalid Builder Arena API key' });
      return null;
    }
    // Attach the apiKey we authenticated with so downstream logic can
    // disambiguate agents that share the same display name.
    return { ...agentInfo, apiKey };
  };

  // ── GET /api/betting/contract-info ───────────────────────────────────
  // No auth. Returns contract address, ABI, chain info, Reown project ID for wallet modal.
  router.get('/contract-info', (_req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    res.json({
      configured: isConfigured(),
      contractAddress: getContractAddress(),
      abi: getContractABI(),
      chain: getChainInfo(),
      reownProjectId: process.env.REOWN_PROJECT_ID || null,
    });
  });

  // ── GET /api/betting/status/:matchId ─────────────────────────────────
  // No auth. Live odds, pool sizes, bettor counts.
  router.get('/status/:matchId', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    try {
      const token = req.query.token === 'MCLAW' ? 'MCLAW' : 'MON';
      const status = await bettingService.getBettingStatus(req.params.matchId, token);
      res.json(status);
    } catch (err) {
      console.error('[betting/routes] /status failed:', err);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── POST /api/betting/register-wallet ────────────────────────────────
  // Agent auth required. { walletAddress }
  router.post('/register-wallet', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    const agent = await authenticateAgent(req, res);
    if (!agent) return;

    const { walletAddress } = req.body;
    if (!walletAddress || typeof walletAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      res.status(400).json({ success: false, error: 'INVALID_ADDRESS', message: 'Provide a valid Ethereum wallet address' });
      return;
    }

    const ok = await bettingService.registerAgentWallet(agent.name, agent.apiKey, walletAddress);
    if (ok) {
      res.json({ success: true, message: `Wallet ${walletAddress} linked to agent ${agent.name}` });
    } else {
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'Failed to register wallet' });
    }
  });

  // ── POST /api/betting/place-bet-direct ───────────────────────────────
  // Agent auth required. { matchId, agentName, amount, txHash, token? }
  //
  // Flow:
  // 1. Agent signs and sends an on-chain placeBet() tx from its OWN wallet
  //    (same as a human using the UI).
  // 2. After the tx is broadcast/confirmed, the agent calls this endpoint
  //    to record the bet in the off-chain DB and betting leaderboard.
  //
  // amount is in wei (string) or MON (number — converted to wei).
  router.post('/place-bet-direct', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    const agent = await authenticateAgent(req, res);
    if (!agent) return;

    const { matchId, agentName, amount, txHash, token } = req.body;
    if (!matchId || !agentName || !amount || !txHash) {
      res.status(400).json({
        success: false,
        error: 'BAD_REQUEST',
        message: 'matchId, agentName, amount, and txHash are required',
      });
      return;
    }

    // Get agent's registered wallet address (the one that paid for the tx),
    // using both name and API key to uniquely identify the agent.
    const walletAddress = await bettingService.getAgentWallet(agent.name, agent.apiKey);
    if (!walletAddress) {
      res.status(400).json({
        success: false,
        error: 'NO_WALLET',
        message: 'Register your wallet first: POST /api/betting/register-wallet { walletAddress }',
      });
      return;
    }

    // Convert amount to wei string
    let amountWei: string;
    if (typeof amount === 'string' && amount.length > 10) {
      // Already in wei
      amountWei = amount;
    } else {
      // Treat as MON (number or small string), convert to wei
      try {
        const monValue = parseFloat(String(amount));
        amountWei = BigInt(Math.round(monValue * 1e18)).toString();
      } catch {
        res.status(400).json({ success: false, error: 'INVALID_AMOUNT', message: 'amount must be a valid number' });
        return;
      }
    }

    const result = await bettingService.placeBet({
      bettorAddress: walletAddress,
      bettorType: 'agent',
      bettorName: agent.name,
      matchId,
      agentName,
      amountWei,
      token: token === 'MCLAW' ? 'MCLAW' : 'MON',
      txHash,
    });

    if (result.success) {
      res.json({ success: true, txHash: result.txHash, message: 'Bet recorded successfully' });
    } else {
      res.status(400).json({ success: false, error: 'BET_FAILED', message: result.error });
    }
  });

  // ── POST /api/betting/claim ──────────────────────────────────────────
  // Agent auth required. { matchId }
  router.post('/claim', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    const agent = await authenticateAgent(req, res);
    if (!agent) return;

    const { matchId } = req.body;
    if (!matchId) {
      res.status(400).json({ success: false, error: 'BAD_REQUEST', message: 'matchId is required' });
      return;
    }

    const walletAddress = await bettingService.getAgentWallet(agent.name, agent.apiKey);
    if (!walletAddress) {
      res.status(400).json({ success: false, error: 'NO_WALLET', message: 'No wallet registered' });
      return;
    }

    const result = await bettingService.claimWinnings(walletAddress, matchId);
    if (result.success) {
      res.json({
        success: true,
        txHashMon: result.txHashMon || null,
        txHashMclaw: result.txHashMclaw || null,
        payoutMon: result.payoutMon || '0',
        payoutMclaw: result.payoutMclaw || '0',
      });
    } else {
      res.status(400).json({ success: false, error: 'CLAIM_FAILED', message: result.error });
    }
  });

  // ── GET /api/betting/my-bets ─────────────────────────────────────────
  // Agent auth required. Optional ?matchId=
  router.get('/my-bets', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    const agent = await authenticateAgent(req, res);
    if (!agent) return;

    const walletAddress = await bettingService.getAgentWallet(agent.name, agent.apiKey);
    if (!walletAddress) {
      res.json({ bets: [] });
      return;
    }

    const matchId = typeof req.query.matchId === 'string' ? req.query.matchId : undefined;
    const token = req.query.token === 'MCLAW' ? 'MCLAW' : undefined;
    const bets = await bettingService.getUserBets(walletAddress, matchId, token);
    res.json({ bets });
  });

  // ── GET /api/betting/history/:matchId ────────────────────────────────
  // No auth. All bets + settlements for a match.
  router.get('/history/:matchId', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    try {
      const history = await bettingService.getMatchHistory(req.params.matchId);
      res.json(history);
    } catch (err) {
      console.error('[betting/routes] /history failed:', err);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/betting/bets-by-wallet/:address ────────────────────────
  // No auth. Returns all bets for a wallet address, optionally filtered by matchId.
  router.get('/bets-by-wallet/:address', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    const address = req.params.address;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ success: false, error: 'INVALID_ADDRESS' });
      return;
    }
    try {
      const matchId = typeof req.query.matchId === 'string' ? req.query.matchId : undefined;
      const token = req.query.token === 'MCLAW' ? 'MCLAW' : undefined;
      const [bets, stats] = await Promise.all([
        bettingService.getUserBets(address, matchId, token),
        bettingService.getWalletStats(address, token),
      ]);
      res.json({ bets, stats });
    } catch (err) {
      console.error('[betting/routes] /bets-by-wallet failed:', err);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  // ── GET /api/betting/leaderboard ─────────────────────────────────────
  // No auth. Top bettors by volume.
  router.get('/leaderboard', async (req: Request, res: Response) => {
    if (!ensureBettingEnabled(res)) return;
    try {
      const token = req.query.token === 'MCLAW' ? 'MCLAW' : 'MON';
      const leaderboard = await bettingService.getLeaderboard(undefined, token);
      res.json({ leaderboard });
    } catch (err) {
      console.error('[betting/routes] /leaderboard failed:', err);
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
