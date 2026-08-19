import { bscScanAddress, bscScanTx } from "@agripinaa/shared";

import type { VerifiedAgent } from "@/lib/verified";
import { VerifiedIcon } from "./icons";

const NPM = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";

function ProofRow({
  label,
  note,
  href,
  linkText,
}: {
  label: string;
  note?: string;
  href: string;
  linkText: string;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {note && <p className="mt-0.5 text-xs text-muted-2">{note}</p>}
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-mono text-xs text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
      >
        {linkText} ↗
      </a>
    </li>
  );
}

export function ProofPanel({ agent }: { agent: VerifiedAgent }) {
  return (
    <section className="rounded-xl border border-primary/25 bg-[linear-gradient(180deg,rgba(245,158,11,0.05),transparent_40%)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <VerifiedIcon className="h-4 w-4 text-primary" />
        <h2 className="text-xs font-medium uppercase tracking-wider text-primary">
          Proof of execution
        </h2>
      </div>
      <p className="mb-4 text-sm leading-relaxed text-muted">
        Agripinaa built, ran, and verified this agent on BSC mainnet. Every
        claim below is an on-chain artifact you can check yourself.
      </p>
      <ul className="space-y-2">
        <ProofRow
          label="ERC-8004 registration"
          note="Identity NFT minted to the agent's own wallet"
          href={bscScanTx(56, agent.registrationTx)}
          linkText="registration tx"
        />
        {agent.proofs.map((p) => (
          <ProofRow
            key={p.ref}
            label={p.label}
            note={p.note}
            href={
              p.kind === "position"
                ? `${bscScanAddress(56, NPM)}?a=${p.ref}`
                : bscScanTx(56, p.ref)
            }
            linkText={p.kind === "position" ? `position #${p.ref}` : "execution tx"}
          />
        ))}
        <ProofRow
          label="On-chain reputation attestation"
          note={`ERC-8004 ReputationRegistry, tagged "${agent.attestation.tag}"`}
          href={bscScanTx(56, agent.attestation.txHash)}
          linkText="attestation tx"
        />
      </ul>
      <p className="mt-3 flex flex-wrap items-center gap-1 text-[10px] text-muted-2">
        Attested by the Agripinaa Verifier{" "}
        <a
          href={bscScanAddress(56, agent.attestation.verifier)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-muted underline underline-offset-2 hover:text-foreground"
        >
          {agent.attestation.verifier.slice(0, 10)}…
        </a>
        , a wallet distinct from the agent owner (the registry forbids
        self-feedback). The proof is the execution; the attestation anchors our
        verification on-chain.
      </p>
    </section>
  );
}
