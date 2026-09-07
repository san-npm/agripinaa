import Image from 'next/image';
import { AGENTS, type AgentSlug } from '@agripinaa/shared/agents';
import { tokenLogoAsset } from '@/lib/token-logo-assets';

/** Decorative 3D objects, never charts or a representation of account balances. */
export function AgentArtwork({ slug, tokens = false, eager = false, compact = false }: { slug: AgentSlug; tokens?: boolean; eager?: boolean; compact?: boolean }) {
  const execution = AGENTS[slug].manifest.execution;
  const assets = execution.pair?.split('/') ?? [execution.asset ?? 'USDT'];
  return <div className="agent-artwork">
    <Image className="art-object" src={`/agents/${slug}.png`} alt="" width={512} height={512}
      sizes={compact ? '64px' : '(max-width: 640px) 280px, 360px'} loading={eager ? 'eager' : 'lazy'} />
    {tokens && <div className="art-assets" role="group" aria-label="Strategy assets">{assets.map(symbol => <span key={symbol} className="asset-coin">
      <Image src={tokenLogoAsset(symbol)!} alt="" width={32} height={32} unoptimized />
      <span>{symbol}</span>
    </span>)}</div>}
  </div>;
}
