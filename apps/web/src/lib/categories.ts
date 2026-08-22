import type { Category } from "@agripinaa/agent-index";

export const CATEGORY_INFO: Record<
  Category,
  { label: string; blurb: string; explainer: string; tokens: string[] }
> = {
  rebalancing: {
    label: "Rebalancing",
    blurb: "LP range management on concentrated liquidity",
    explainer:
      "These agents manage concentrated-liquidity positions for you. When the market price drifts out of your position's range, the position stops earning fees; a rebalancing agent detects it, swaps back to balance, and re-centers the range so your liquidity keeps working.",
    // Ranger: PancakeSwap V3 WBNB/USDT concentrated liquidity.
    tokens: ["BNB", "USDT"],
  },
  grid: {
    label: "Grid trading",
    blurb: "Mean-reversion grids that buy dips and sell rips",
    explainer:
      "Grid agents place a ladder of buy and sell levels around the current price. When price crosses a line, they trade one step against the move and earn the spread if it reverts. They perform in sideways markets and halt themselves in strong trends.",
    // Grid: mean-reversion on the WBNB/USDT pair.
    tokens: ["BNB", "USDT"],
  },
  yield: {
    label: "Yield optimization",
    blurb: "Venue rotation across lending markets",
    explainer:
      "Yield agents watch supply rates across lending venues and move your deposits to the best one, with hysteresis so they don't churn on noise. Same asset, better rate, no manual monitoring.",
    // Harvester: rotates managed USDT or USDC across Venus/Aave.
    tokens: ["USDT", "USDC"],
  },
  "health-factor": {
    label: "Health factor",
    blurb: "Liquidation protection for lending positions",
    explainer:
      "If you borrow against collateral, a falling health factor can end in liquidation and a penalty. Health-factor agents watch your position around the clock and repay part of the debt from a pre-approved budget before liquidation can happen.",
    // Guardian: WBNB collateral, USDT debt on Aave V3.
    tokens: ["BNB", "USDT"],
  },
};

/** Hub display order: the two categories with the strongest live agents first. */
export const CATEGORY_ORDER: Category[] = [
  "grid",
  "health-factor",
  "yield",
  "rebalancing",
];
