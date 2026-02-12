import { describe, it, expect } from 'vitest';
import { toBytes32, fromBytes32 } from '../contract';

describe('contract helpers', () => {
  it('should round-trip toBytes32 and fromBytes32', () => {
    const original = 'test';
    const encoded = toBytes32(original);
    const decoded = fromBytes32(encoded);
    expect(decoded).toBe(original);
  });

  it('should handle empty string', () => {
    const original = '';
    const encoded = toBytes32(original);
    const decoded = fromBytes32(encoded);
    expect(decoded).toBe(original);
  });

  it('should truncate strings longer than 31 characters', () => {
    const original = 'this is a very long string that exceeds 31 chars';
    const encoded = toBytes32(original);
    const decoded = fromBytes32(encoded);
    // Should be truncated to 31 chars
    expect(decoded).toBe(original.slice(0, 31));
  });
});
