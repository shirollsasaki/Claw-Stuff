/**
 * Ethers.js wrapper for the ClawBetting smart contract on Base mainnet.
 * All write functions are called by the backend "operator" wallet.
 */
import { ethers, JsonRpcProvider, Wallet, Contract, encodeBytes32String, decodeBytes32String } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Load ABI ───────────────────────────────────────────────────────────
const ABI_PATH = join(__dirname, '../../../contracts/ClawBetting.abi.json');
let CONTRACT_ABI: any[];
try {
  CONTRACT_ABI = JSON.parse(readFileSync(ABI_PATH, 'utf-8'));
} catch {
  console.warn('[betting/contract] Could not load ABI from', ABI_PATH);
  CONTRACT_ABI = [];
}

// ── Config from env ────────────────────────────────────────────────────
// Default to Base mainnet RPC; can be overridden via BASE_RPC_URL.
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || '';
const BETTING_CONTRACT_ADDRESS = process.env.BETTING_CONTRACT_ADDRESS || '';

// ── Provider & Wallet ──────────────────────────────────────────────────
let provider: JsonRpcProvider | null = null;
let operatorWallet: Wallet | null = null;
let contract: Contract | null = null;
let readContract: Contract | null = null;

function ensureInit() {
  if (provider) return;

  if (!BETTING_CONTRACT_ADDRESS) {
    console.warn('[betting/contract] BETTING_CONTRACT_ADDRESS not set – betting disabled');
    return;
  }

   provider = new JsonRpcProvider(BASE_RPC_URL);

  // Read-only contract (for view calls even without operator key)
  readContract = new Contract(BETTING_CONTRACT_ADDRESS, CONTRACT_ABI, provider);

  if (OPERATOR_PRIVATE_KEY) {
    operatorWallet = new Wallet(OPERATOR_PRIVATE_KEY, provider);
    contract = new Contract(BETTING_CONTRACT_ADDRESS, CONTRACT_ABI, operatorWallet);
    console.log(`[betting/contract] Operator wallet: ${operatorWallet.address}`);
  } else {
    console.warn('[betting/contract] OPERATOR_PRIVATE_KEY not set – write ops disabled');
  }

   console.log(`[betting/contract] Connected to ${BASE_RPC_URL}, contract ${BETTING_CONTRACT_ADDRESS}`);
}

// ── Helpers ────────────────────────────────────────────────────────────
export function toBytes32(s: string): string {
  return encodeBytes32String(s.length > 31 ? s.slice(0, 31) : s);
}

export function fromBytes32(b: string): string {
  try {
    return decodeBytes32String(b);
  } catch {
    return b;
  }
}

export function isConfigured(): boolean {
  ensureInit();
  return !!contract;
}

export function getContractAddress(): string {
  return BETTING_CONTRACT_ADDRESS;
}

export function getContractABI(): any[] {
  return CONTRACT_ABI;
}

export function getChainInfo() {
   return {
     chainId: 8453,
     rpcUrl: BASE_RPC_URL,
     explorer: 'https://basescan.org',
     currency: 'ETH',
   };
 }

// ── Global tx mutex ─────────────────────────────────────────────────────
// All operator txs must be serialized to avoid nonce collisions.
let txQueue: Promise<any> = Promise.resolve();

function enqueueOperatorTx<T>(fn: () => Promise<T>): Promise<T> {
  const p = txQueue.then(fn, fn); // run even if previous tx failed
  txQueue = p.then(() => {}, () => {}); // swallow so queue keeps going
  return p as Promise<T>;
}

// ── Write functions (operator) ─────────────────────────────────────────

export function openBetting(matchId: string, agentNames: string[]): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const matchIdB32 = toBytes32(matchId);
      const agentIdsB32 = agentNames.map(toBytes32);
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.openBetting(matchIdB32, agentIdsB32, { nonce });
      const receipt = await tx.wait();
      console.log(`[betting/contract] openBetting(${matchId}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] openBetting failed:', err);
      return null;
    }
  });
}

export function addAgents(matchId: string, agentNames: string[]): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const matchIdB32 = toBytes32(matchId);
      const agentIdsB32 = agentNames.map(toBytes32);
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.addAgents(matchIdB32, agentIdsB32, { nonce });
      const receipt = await tx.wait();
      console.log(`[betting/contract] addAgents(${matchId}, [${agentNames.join(', ')}]) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] addAgents failed:', err);
      return null;
    }
  });
}

export function placeBetFor(
  bettorAddress: string,
  matchId: string,
  agentName: string,
  amountWei: string,
): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.placeBetFor(
        bettorAddress,
        toBytes32(matchId),
        toBytes32(agentName),
        { value: amountWei, nonce },
      );
      const receipt = await tx.wait();
      console.log(`[betting/contract] placeBetFor(${bettorAddress}, ${matchId}, ${agentName}, ${amountWei}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] placeBetFor failed:', err);
      return null;
    }
  });
}

export function closeBetting(matchId: string): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.closeBetting(toBytes32(matchId), { nonce });
      const receipt = await tx.wait();
      console.log(`[betting/contract] closeBetting(${matchId}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] closeBetting failed:', err);
      return null;
    }
  });
}

export function resolveMatch(
  matchId: string,
  winnerAgentNames: string[],
  winnerAgentWallets: string[],
): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.resolveMatch(
        toBytes32(matchId),
        winnerAgentNames.map(toBytes32),
        winnerAgentWallets,
        { nonce },
      );
      const receipt = await tx.wait();
      console.log(`[betting/contract] resolveMatch(${matchId}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] resolveMatch failed:', err);
      return null;
    }
  });
}

export function claimFor(bettorAddress: string, matchId: string): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.claimFor(bettorAddress, toBytes32(matchId), { nonce });
      const receipt = await tx.wait();
      console.log(`[betting/contract] claimFor(${bettorAddress}, ${matchId}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] claimFor failed:', err);
      return null;
    }
  });
}

export function claimMclawFor(bettorAddress: string, matchId: string): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.claimMclawFor(bettorAddress, toBytes32(matchId), { nonce });
      const receipt = await tx.wait();
      console.log(`[betting/contract] claimMclawFor(${bettorAddress}, ${matchId}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] claimMclawFor failed:', err);
      return null;
    }
  });
}

export function cancelMatch(matchId: string): Promise<string | null> {
  ensureInit();
  if (!contract) return Promise.resolve(null);
  return enqueueOperatorTx(async () => {
    try {
      const nonce = await operatorWallet!.getNonce();
      const tx = await contract!.cancelMatch(toBytes32(matchId), { nonce });
      const receipt = await tx.wait();
      console.log(`[betting/contract] cancelMatch(${matchId}) tx: ${receipt.hash}`);
      return receipt.hash as string;
    } catch (err) {
      console.error('[betting/contract] cancelMatch failed:', err);
      return null;
    }
  });
}

// ── Read functions ─────────────────────────────────────────────────────

export async function getMatchStatus(matchId: string) {
  ensureInit();
  if (!readContract) return null;
  try {
    const result = await readContract.getMatchStatus(toBytes32(matchId));
    return {
      status: Number(result[0]),             // enum MatchStatus
      totalPoolMon: result[1].toString(),    // bigint → string
      totalPoolMclaw: result[2].toString(),  // bigint → string
      agentIds: (result[3] as string[]).map(fromBytes32),
      winnerAgentIds: (result[4] as string[]).map(fromBytes32),
    };
  } catch (err) {
    console.error('[betting/contract] getMatchStatus failed:', err);
    return null;
  }
}

export async function getAgentPool(matchId: string, agentName: string): Promise<string> {
  ensureInit();
  if (!readContract) return '0';
  try {
    const val = await readContract.getAgentPool(toBytes32(matchId), toBytes32(agentName));
    return val.toString();
  } catch {
    return '0';
  }
}

export async function getBet(matchId: string, bettor: string, agentName: string): Promise<string> {
  ensureInit();
  if (!readContract) return '0';
  try {
    const val = await readContract.getBet(toBytes32(matchId), bettor, toBytes32(agentName));
    return val.toString();
  } catch {
    return '0';
  }
}

export async function getClaimableAmounts(matchId: string, bettor: string): Promise<{ monAmount: string; mclawAmount: string }> {
  ensureInit();
  if (!readContract) return { monAmount: '0', mclawAmount: '0' };
  try {
    const result = await readContract.getClaimableAmounts(toBytes32(matchId), bettor);
    return {
      monAmount: result[0].toString(),
      mclawAmount: result[1].toString(),
    };
  } catch {
    return { monAmount: '0', mclawAmount: '0' };
  }
}

export async function hasClaimed(matchId: string, bettor: string): Promise<boolean> {
  ensureInit();
  if (!readContract) return false;
  try {
    return await readContract.hasClaimed(toBytes32(matchId), bettor);
  } catch {
    return false;
  }
}

export async function getBettorCount(matchId: string): Promise<number> {
  ensureInit();
  if (!readContract) return 0;
  try {
    const val = await readContract.getBettorCount(toBytes32(matchId));
    return Number(val);
  } catch {
    return 0;
  }
}
