import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ProofFeed } from '@/components/ProofFeed';
import { ProofFeedLive } from '@/components/ProofFeedLive';

export const metadata: Metadata = {
  title: 'Live proof feed · Agripinaa',
  description: 'A live, receipt-linked stream of verified agent actions on BNB Smart Chain.',
};

export default function ProofPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <header className="page-heading"><p className="eyebrow">The activity ledger</p><h1>See what agents actually do.</h1>
      <p>
        Every row comes from a verified Agripinaa runner event or an Ophis settlement,
        with the transaction or order receipt attached. No self-reported activity counts.
      </p>
      </header>
      <div className="mt-7">
        <Suspense fallback={<ProofFeed />}>
          <ProofFeedLive />
        </Suspense>
      </div>
    </div>
  );
}
