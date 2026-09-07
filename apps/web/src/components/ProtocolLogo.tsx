import Image from 'next/image';
import type { AgentSlug } from '@agripinaa/shared/agents';
import { agentExperience } from '@/lib/agent-experience';

export const PROTOCOL_NAMES = { aave: 'Aave', venus: 'Venus', pancakeswap: 'PancakeSwap V3', ophis: 'Ophis', 'bnb-chain': 'BNB Chain' } as const;

/** Official marks keep their proportions and colors; only their surface has depth. */
export function ProtocolLogo({ protocol }: { protocol: keyof typeof PROTOCOL_NAMES }) {
  return <span className="protocol-logo" data-protocol={protocol}>
    <Image src={`/protocols/${protocol}.svg`} alt={PROTOCOL_NAMES[protocol]} width={160} height={36} unoptimized />
    {protocol === 'ophis' && <span aria-hidden>Ophis</span>}
  </span>;
}

export function AgentProtocols({ slug }: { slug: AgentSlug }) {
  return <div className="agent-protocols" role="group" aria-label="Strategy protocols">
    {agentExperience(slug).protocols.map(protocol => <ProtocolLogo key={protocol} protocol={protocol} />)}
  </div>;
}
