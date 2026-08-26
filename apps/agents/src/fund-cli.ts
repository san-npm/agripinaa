import { parseFlags, type FlagSpec } from './cli-flags';

const FUND_FLAGS: FlagSpec = {
  value: ['--only'],
  boolean: ['--gen', '--plan', '--execute'],
};

export type FundingMode = '--gen' | '--plan' | '--execute';

/** Strictly parse the non-idempotent funding script before it can sign. */
export function parseFundingArgs(args: readonly string[]): {
  mode: FundingMode;
  only?: string;
} {
  const flags = parseFlags(args, FUND_FLAGS);
  const modes = (FUND_FLAGS.boolean ?? []).filter((mode) => flags.has(mode)) as FundingMode[];
  if (modes.length > 1) throw new Error(`funding modes conflict: ${modes.join(', ')}`);
  return { mode: modes[0] ?? '--plan', only: flags.value('--only') };
}
