import { describe, it, expect } from 'vitest';
import { getChainInfo } from '../contract';

describe('chain migration: Monad → Base', () => {
  it('should return chainId 8453 (Base mainnet)', () => {
    const chainInfo = getChainInfo();
    expect(chainInfo.chainId).toBe(8453);
  });

  it('should return currency ETH (not MON)', () => {
    const chainInfo = getChainInfo();
    expect(chainInfo.currency).toBe('ETH');
  });

  it('should return Base explorer URL (basescan.org)', () => {
    const chainInfo = getChainInfo();
    expect(chainInfo.explorer).toBe('https://basescan.org');
  });

  it('should use BASE_RPC_URL env var with Base mainnet default', () => {
    const chainInfo = getChainInfo();
    expect(chainInfo.rpcUrl).toBe('https://mainnet.base.org');
  });

  it('should not reference Monad RPC URL', () => {
    const chainInfo = getChainInfo();
    expect(chainInfo.rpcUrl).not.toContain('monad');
  });
});
