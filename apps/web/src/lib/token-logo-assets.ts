export type TokenLogoKind = 'usdt' | 'usdc' | 'bnb' | 'btcb' | 'generic';

/** Pure mapping kept testable so a listed asset never silently gets a generic mark. */
export function tokenLogoKind(symbol: string): TokenLogoKind {
  const normalized = symbol.toUpperCase();
  if (normalized === 'USDT') return 'usdt';
  if (normalized === 'USDC') return 'usdc';
  if (normalized === 'BNB' || normalized === 'TBNB' || normalized === 'WBNB') return 'bnb';
  if (normalized === 'BTCB') return 'btcb';
  return 'generic';
}

/** Stable public path for every supported asset's official logo. */
export function tokenLogoAsset(symbol: string): string | null {
  const kind = tokenLogoKind(symbol);
  if (kind === 'usdt') return '/tokens/tether-usdt-logo.svg';
  if (kind === 'usdc') return '/tokens/usd-coin-usdc-logo.svg';
  if (kind === 'bnb') return '/tokens/bnb-bnb-logo.svg';
  if (kind === 'btcb') return '/tokens/bitcoin-btc-logo.svg';
  return null;
}
