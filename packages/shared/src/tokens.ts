export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

/**
 * Token registry for BNB Chain (56). Single source of truth: every amount
 * conversion in the repo goes through toBaseUnits/fromBaseUnits with the
 * decimals defined HERE.
 *
 * USDT and USDC are 18 decimals on BNB Chain (USDT is 6 on Ethereum). A
 * hardcoded 6 anywhere silently turns a $50 session spend cap into $0.00005.
 */
export const TOKENS_BSC: Record<string, TokenInfo> = {
  WBNB: {
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    symbol: 'WBNB',
    decimals: 18,
  },
  USDT: {
    address: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    decimals: 18,
  },
  USDC: {
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    decimals: 18,
  },
  /*
   * Bitcoin BEP20, the Binance-pegged BTC on BNB Chain. Also 18 decimals, which
   * is what lets a grid read its pool price straight off slot0 with no power of
   * ten correction (grid-core refuses a pair whose sides disagree). Verified
   * on-chain 2026-08-25 against https://bsc-rpc.publicnode.com: decimals() 18,
   * symbol() "BTCB".
   */
  BTCB: {
    address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    symbol: 'BTCB',
    decimals: 18,
  },
};

/** "12.5" + 18 decimals → BigInt("12500000000000000000"). Throws on malformed input. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid decimal amount: "${amount}"`);
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${amount}" has more fractional digits than token decimals (${decimals})`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
