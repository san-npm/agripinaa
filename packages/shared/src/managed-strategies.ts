import type { AgentSlug } from './agents';
import { ROUTER_ACTIONS, routerFor } from './contracts';
import { TOKENS_BSC } from './tokens';

export type ManagedStrategySlug = Exclude<AgentSlug, 'yield' | 'yield-b'>;

export const OPHIS_SETTLEMENT_BSC =
  '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;
export const OPHIS_VAULT_RELAYER_BSC =
  '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const;
export const AAVE_V3_BSC_POOL =
  '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' as const;
export const VENUS_VUSDT =
  '0xfD5840Cd36d94D7229439859C0112a4185BC0255' as const;
export const PANCAKE_V3_POSITION_MANAGER =
  '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as const;

export interface ManagedCallScope {
  to: `0x${string}`;
  signatures: readonly string[];
}

export interface ManagedApproval {
  token: keyof typeof TOKENS_BSC;
  spender: `0x${string}`;
}

export interface ManagedSpendCap {
  token: keyof typeof TOKENS_BSC;
  /** Whole-token daily ceiling, converted with the pinned token decimals. */
  amount: string;
}

export interface ManagedStrategyDefinition {
  slug: ManagedStrategySlug;
  /** Accepted strategy assets. Funding any one is enough to activate. */
  depositTokens: readonly (keyof typeof TOKENS_BSC)[];
  /** Explains how this strategy behaves when only one accepted asset is funded. */
  fundingNote: string;
  callScopes: readonly ManagedCallScope[];
  approvals: readonly ManagedApproval[];
  /** Direct-call token outflows beyond the canonical USDT ceiling. */
  additionalSpendCaps: readonly ManagedSpendCap[];
  /** ERC-1271 callers that may validate this session key's off-chain signatures. */
  signatureCheckers: readonly `0x${string}`[];
  usesOphis: boolean;
  summary: string;
  riskNote: string;
}

const BALANCE_ONLY_SCOPE: readonly ManagedCallScope[] = [{
  to: TOKENS_BSC.USDT!.address,
  signatures: ['balanceOf(address)'],
}];

const OPHIS_WBNB_USDT_APPROVALS: readonly ManagedApproval[] = [
  { token: 'WBNB', spender: OPHIS_VAULT_RELAYER_BSC },
  { token: 'USDT', spender: OPHIS_VAULT_RELAYER_BSC },
];

/**
 * Canonical non-yield mandates. The browser grants exactly these selectors,
 * the public handoff rebuilds exactly these bytes, and the runner rejects any
 * entry that differs. Trading signatures are additionally pinned to the CoW
 * settlement as their sole ERC-1271 checker.
 *
 * Ophis and Pancake approvals deliberately live in the activation's ADMIN
 * transaction, not in the session. A manager key can therefore never call an
 * ERC-20 approve selector or choose a new spender. These accounts should hold
 * only the capital assigned to the selected strategy; that is surfaced in the
 * activation UI because an ERC-1271 CoW signer controls the approved strategy
 * inventory even though it cannot transfer unrelated assets directly.
 */
export const MANAGED_STRATEGIES: Record<ManagedStrategySlug, ManagedStrategyDefinition> = {
  grid: {
    slug: 'grid',
    depositTokens: ['WBNB', 'USDT'],
    fundingNote: 'A single BTCB, BNB, USDT, or USDC deposit is prepared into both WBNB and USDT before the grid starts.',
    callScopes: BALANCE_ONLY_SCOPE,
    approvals: OPHIS_WBNB_USDT_APPROVALS,
    additionalSpendCaps: [],
    signatureCheckers: [OPHIS_SETTLEMENT_BSC],
    usesOphis: true,
    summary: 'Runs the WBNB/USDT mean-reversion ladder from your dedicated strategy account.',
    riskNote: 'Use a dedicated account containing only the WBNB and USDT you assign to this grid.',
  },
  'grid-b': {
    slug: 'grid-b',
    depositTokens: ['BTCB', 'USDT'],
    fundingNote: 'A single BTCB, BNB, USDT, or USDC deposit is prepared into both BTCB and USDT before the grid starts.',
    callScopes: BALANCE_ONLY_SCOPE,
    approvals: [
      { token: 'BTCB', spender: OPHIS_VAULT_RELAYER_BSC },
      { token: 'USDT', spender: OPHIS_VAULT_RELAYER_BSC },
    ],
    additionalSpendCaps: [],
    signatureCheckers: [OPHIS_SETTLEMENT_BSC],
    usesOphis: true,
    summary: 'Runs the wider BTCB/USDT ladder from your dedicated strategy account.',
    riskNote: 'Use a dedicated account containing only the BTCB and USDT you assign to this grid.',
  },
  'health-factor': {
    slug: 'health-factor',
    depositTokens: ['USDT'],
    fundingNote: 'A single BTCB, BNB, USDT, or USDC deposit is converted into the USDT repair reserve. The Aave collateral and debt must already exist; Guardian never sells collateral or opens debt.',
    callScopes: [{
      to: AAVE_V3_BSC_POOL,
      signatures: ['repay(address,uint256,uint256,address)'],
    }],
    approvals: [{ token: 'USDT', spender: AAVE_V3_BSC_POOL }],
    additionalSpendCaps: [],
    signatureCheckers: [],
    usesOphis: false,
    summary: 'Monitors this account\'s Aave position and spends its USDT repair reserve when health factor falls.',
    riskNote: 'The account must already hold the Aave collateral and debt you want guarded; activation never creates debt.',
  },
  'venus-guardian': {
    slug: 'venus-guardian',
    depositTokens: ['USDT'],
    fundingNote: 'A single BTCB, BNB, USDT, or USDC deposit is converted into the USDT repair reserve. The Venus collateral and debt must already exist; Venus Guardian never sells collateral or opens debt.',
    callScopes: [{ to: VENUS_VUSDT, signatures: ['repayBorrow(uint256)'] }],
    approvals: [{ token: 'USDT', spender: VENUS_VUSDT }],
    additionalSpendCaps: [],
    signatureCheckers: [],
    usesOphis: false,
    summary: 'Monitors this account\'s Venus position and spends its USDT repair reserve when health factor falls.',
    riskNote: 'The account must already hold the Venus collateral and debt you want guarded; activation never creates debt.',
  },
  'lp-range': {
    slug: 'lp-range',
    depositTokens: ['WBNB', 'USDT'],
    fundingNote: 'A single BTCB, BNB, USDT, or USDC deposit is prepared into WBNB and USDT before Ranger mints the range.',
    callScopes: [{
      to: PANCAKE_V3_POSITION_MANAGER,
      signatures: [
        'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
        'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
        'collect((uint256,address,uint128,uint128))',
      ],
    }],
    approvals: [
      ...OPHIS_WBNB_USDT_APPROVALS,
      { token: 'WBNB', spender: PANCAKE_V3_POSITION_MANAGER },
      { token: 'USDT', spender: PANCAKE_V3_POSITION_MANAGER },
    ],
    // mint() spends both legs through the position manager. Without a WBNB
    // spend permission Porto correctly rejects the first managed mint even
    // though the target and selector are authorized.
    additionalSpendCaps: [{ token: 'WBNB', amount: '100' }],
    signatureCheckers: [OPHIS_SETTLEMENT_BSC],
    usesOphis: true,
    summary: 'Mints and maintains a ±5% Pancake V3 WBNB/USDT range from your strategy account.',
    riskNote: 'Use a dedicated account: this mandate controls the Pancake position and the two assets assigned to it.',
  },
  'weight-rebalancer': {
    slug: 'weight-rebalancer',
    depositTokens: ['WBNB', 'USDT'],
    fundingNote: 'A single BTCB, BNB, USDT, or USDC deposit is prepared toward the WBNB/USDT 50/50 target.',
    callScopes: BALANCE_ONLY_SCOPE,
    approvals: OPHIS_WBNB_USDT_APPROVALS,
    additionalSpendCaps: [],
    signatureCheckers: [OPHIS_SETTLEMENT_BSC],
    usesOphis: true,
    summary: 'Keeps your dedicated WBNB/USDT strategy account near a 50/50 value split.',
    riskNote: 'Use a dedicated account containing only the WBNB and USDT assigned to this rebalancer.',
  },
};

export function managedStrategyFor(slug: string): ManagedStrategyDefinition | undefined {
  return Object.hasOwn(MANAGED_STRATEGIES, slug)
    ? MANAGED_STRATEGIES[slug as ManagedStrategySlug]
    : undefined;
}

/** Yield and non-yield sessions share one canonical permission lookup. */
export function managedCallScopesFor(slug: AgentSlug, chainId: number, token = 'USDT'):
  readonly ManagedCallScope[] | undefined {
  if (slug === 'yield' || slug === 'yield-b') {
    const router = routerFor(chainId, token);
    if (!router) return undefined;
    return [{ to: router.address, signatures: Object.values(ROUTER_ACTIONS).map((a) => a.signature) }];
  }
  return managedStrategyFor(slug)?.callScopes;
}
