import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ProofFeed } from '@/components/ProofFeed';
import { ProofFeedLive } from '@/components/ProofFeedLive';
import { ReceiptIcon } from '@/components/icons';

export const metadata: Metadata = {
  title: 'Live proof feed · Agripinaa',
  description: 'A live, receipt-linked stream of verified agent actions on BNB Smart Chain.',
};

export default function ProofPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <span className="grid h-11 w-11 place-items-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
        <ReceiptIcon className="h-5 w-5" />
      </span>
      <h1 className="mt-4 font-display text-3xl font-semibold">Proof, as it happens</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Every row comes from a verified Agripinaa runner event or an Ophis settlement,
        with the transaction or order receipt attached. No self-reported activity counts.
      </p>
      <div className="mt-7">
        <Suspense fallback={<ProofFeed />}>
          <ProofFeedLive />
        </Suspense>
      </div>
    </div>
  );
}
