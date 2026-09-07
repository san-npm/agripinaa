'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AGENT_LIST } from '@agripinaa/shared/agents';
import { agentExperience } from '@/lib/agent-experience';
import { AgentArtwork } from './AgentArtwork';
import { AgentProtocols } from './ProtocolLogo';

// Only configured, registered identities. Selecting a preview grants no authority.
const agents = AGENT_LIST.filter(agent => agent.tokenId !== null);

export function AgentStudio() {
  const [selected, setSelected] = useState(0);
  const agent = agents[selected];
  if (!agent) return null;
  const experience = agentExperience(agent.slug);
  return <div className="agent-studio">
    <div className="studio-stage agent-visual" data-agent={agent.slug}>
      <div className="studio-topline"><span>THE AGENT COLLECTION</span><span>0{selected + 1} / 0{agents.length}</span></div>
      <AgentArtwork key={agent.slug} slug={agent.slug} tokens eager />
      <div className="studio-identity" aria-live="polite" aria-atomic="true">
        <p>{experience.directoryLabel}</p>
        <h2>{agent.name.replace(/^Agripinaa /, '')}</h2>
      </div>
    </div>
    <div className="studio-selectors" role="group" aria-label="Preview an agent">
      {agents.map((item, index) => <button key={item.slug} type="button" className="agent-visual" data-agent={item.slug}
        aria-label={`Preview ${item.name}`} aria-pressed={index === selected} onClick={() => setSelected(index)} title={item.name}>
        <AgentArtwork slug={item.slug} compact />
      </button>)}
    </div>
    <AgentProtocols slug={agent.slug} />
    <div className="studio-detail">
      <p>{experience.summary}</p>
      <Link href={`/agent/${agent.manifest.execution.chainId}/${agent.tokenId}`}>Meet {agent.name.replace(/^Agripinaa /, '')} <span aria-hidden>↗</span></Link>
    </div>
  </div>;
}
