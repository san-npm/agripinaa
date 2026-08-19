import type { Category } from "@agripinaa/agent-index";

export interface ExecutionProof {
  label: string;
  /** BscScan tx hash, or a token id for an NFT position. */
  ref: string;
  kind: "tx" | "position";
  note: string;
}

export interface VerifiedAgent {
  tokenId: string;
  name: string;
  category: Category;
  registrationTx: string;
  attestation: {
    txHash: string;
    verifier: string;
    tag: string;
    feedbackHash: string;
  };
  proofs: ExecutionProof[];
}

const VERIFIER = "0x80c545ef426aa9e46543E5ac2BA4B9728CeB58A1";

/**
 * First-party proof records for the agents Agripinaa built, ran, and verified
 * on BSC mainnet. Every reference here is an on-chain artifact anyone can
 * check: the ERC-8004 registration, the reputation attestation, and the
 * agent's real execution. This is what "verified" means on this marketplace,
 * as distinct from the unverified registry long tail.
 */
export const VERIFIED_AGENTS: Record<string, VerifiedAgent> = {
  "269703": {
    tokenId: "269703",
    name: "Agripinaa Grid",
    category: "grid",
    registrationTx: "0x8fceeefa8bdf6796251b39ce2f8530ba68a84116ead0edf6277fe09e847b2b4b",
    attestation: {
      txHash: "0xe68fa1443f7bcc785435a17cec3e8809d05b3854451dc78a815b356d6e89b61f",
      verifier: VERIFIER,
      tag: "agripinaa-verified · grid",
      feedbackHash: "anchored to the Ophis order below",
    },
    proofs: [
      {
        label: "Ophis order filled",
        ref: "0xa2fa52fa97922df8b884345a2959a71209a73957073098c4af76cbd72fa1f02b053fff26d28ff4e94dfe862b184f918a50c6f7066a848e4c",
        kind: "tx",
        note: "WBNB → USDT via batch auction, +48.61 bps surplus vs signed limit",
      },
    ],
  },
  "269704": {
    tokenId: "269704",
    name: "Agripinaa Guardian",
    category: "health-factor",
    registrationTx: "0x60644577f63a2d5b49136de8507ff4b1e1dd0233d0dec247ae592b09630d310b",
    attestation: {
      txHash: "0x3338e7083743cef92336bf38459bc3e67a733f3c2df764c6ea7012389e6c29b8",
      verifier: VERIFIER,
      tag: "agripinaa-verified · health-factor",
      feedbackHash: "anchored to the liquidation-drill repay below",
    },
    proofs: [
      {
        label: "Liquidation drill: autonomous repay",
        ref: "0x367cb2dc8ab49a0960077ac0e30b58c2d200bc21ecc2bf184c367050b4b0050a",
        kind: "tx",
        note: "HF pushed to 1.25, agent repaid to 1.60 in ~62s, unattended",
      },
    ],
  },
  "269705": {
    tokenId: "269705",
    name: "Agripinaa Harvester",
    category: "yield",
    registrationTx: "0xe1635838277c5a37bec53e9f2e76c5f4e8d4324b1e49f3e48992688f7adefe02",
    attestation: {
      txHash: "0x10005a89f8bde342947866f972f544bd4376681f8f8bdcec3564366e16f9adc4",
      verifier: VERIFIER,
      tag: "agripinaa-verified · yield",
      feedbackHash: "anchored to the Aave supply below",
    },
    proofs: [
      {
        label: "Rate-picked supply on Aave V3",
        ref: "0xefa6d0840e9974fdd28700116f152d054e3c5f178417e36d06f85399a30e058f",
        kind: "tx",
        note: "Read Venus 202 bps vs Aave 207 bps on-chain, supplied to the winner",
      },
    ],
  },
  "269706": {
    tokenId: "269706",
    name: "Agripinaa Ranger",
    category: "rebalancing",
    registrationTx: "0x8c417a60a0733ea8c94e3dd7d6b7e9d045651b7f4aff6713429242f6432c7e01",
    attestation: {
      txHash: "0x89a33aa7661447b2d73e8ac69e78f2db11c86e4992b6558db3118dbeab1fdd82",
      verifier: VERIFIER,
      tag: "agripinaa-verified · rebalancing",
      feedbackHash: "anchored to the V3 position below",
    },
    proofs: [
      {
        label: "PancakeSwap V3 position minted",
        ref: "7173629",
        kind: "position",
        note: "Concentrated-liquidity WBNB/USDT position, managed in range",
      },
    ],
  },
};

export function isVerified(tokenId: string): boolean {
  return tokenId in VERIFIED_AGENTS;
}

export const VERIFIED_IDS = Object.keys(VERIFIED_AGENTS);
