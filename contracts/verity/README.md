# Agripinaa Verity proofs

This directory contains the Lean 4 / Verity security model for
[`AgripinaaYieldRouter.sol`](../src/AgripinaaYieldRouter.sol).

The model machine-checks the router's central control-flow invariants over all
modeled inputs:

- the output recipient is always the calling smart account;
- no distinct third party can be the output recipient;
- the selected target leg is not needlessly round-tripped;
- debt-encumbered Aave and Venus legs are not collected;
- delta accounting excludes assets already stranded in the router.

## Honest verification boundary

Verity does not ingest Solidity directly. This is a scoped semantic model, not
a byte-for-byte proof that the deployed Solidity implements the model. The
audit separately checks that each Solidity branch matches these modeled
decisions. Aave, Venus, ERC-20 return semantics, immutable deployment addresses,
the Verity-to-Yul compiler, and `solc`'s Yul-to-bytecode step remain explicit
trust boundaries. No theorem below claims otherwise.

The artifact was checked against Verity commit
`cca73c39a4f49176fc01c570febb31ea891b3898` with Lean `v4.31.0`.

## Reproduce

```sh
git clone https://github.com/lfglabs-dev/verity.git
cd verity
git checkout cca73c39a4f49176fc01c570febb31ea891b3898
cp -R /path/to/agripinaa/contracts/verity/Contracts/AgripinaaYieldRouter Contracts/
lake env lean Contracts/AgripinaaYieldRouter/SecurityModel.lean
```

The check must complete with no errors and no `sorry` declarations.
