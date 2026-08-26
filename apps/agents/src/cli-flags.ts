/**
 * Flag parsing for the agent CLIs.
 *
 * attest.ts turns these flags into a mainnet ReputationRegistry transaction
 * that cannot be taken back, so a flag it cannot read must stop the run rather
 * than resolve to something plausible. Scanning argv with indexOf and reading
 * the next slot did the opposite: `--ref --label pancake` read '--label' as the
 * reference and would have signed keccak256('pancake:--label'), a trailing
 * `--ref` fell back to the stale registry proof, and `--only` with no value
 * selected every registered agent.
 *
 * Every input is therefore a declared flag: a value flag takes exactly one
 * value (`--only lp-range` or `--only=lp-range`), a boolean flag takes none,
 * an unknown flag, a bare word, a repeat and a missing value each throw.
 */

export interface FlagSpec {
  /** Flags that carry a value, e.g. --only lp-range. */
  value: readonly string[];
  /** Flags that stand alone, e.g. --dry-run. */
  boolean: readonly string[];
}

/** The parsed line. Only flags named in the spec can be asked for. */
export interface Flags {
  /** The value of a value flag, or undefined when it was not passed. */
  value(name: string): string | undefined;
  /** Whether a flag was passed at all. */
  has(name: string): boolean;
}

export function parseFlags(args: readonly string[], spec: FlagSpec): Flags {
  const values = new Map<string, string>();
  const present = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument ${token}; every input is a flag, written --name value`);
    }
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const joined = eq >= 0 ? token.slice(eq + 1) : undefined;

    if (present.has(name)) throw new Error(`${name} given twice; pass it once`);

    if (spec.boolean.includes(name)) {
      if (joined !== undefined) throw new Error(`${name} takes no value`);
      present.add(name);
      continue;
    }
    if (!spec.value.includes(name)) {
      throw new Error(`unknown option ${name}`);
    }
    // A following flag is never this flag's value: that is how a value-less
    // --ref used to swallow --label and sign the wrong anchor.
    const next = joined ?? args[i + 1];
    if (next === undefined || next.length === 0 || (joined === undefined && next.startsWith('--'))) {
      throw new Error(`${name} needs a value, e.g. ${name} <value>`);
    }
    present.add(name);
    values.set(name, next);
    if (joined === undefined) i += 1;
  }

  return {
    value: (name: string) => values.get(name),
    has: (name: string) => present.has(name),
  };
}
