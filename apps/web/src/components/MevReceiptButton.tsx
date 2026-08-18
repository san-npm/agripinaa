'use client';

import { exportReceiptJson, type MevProofReceipt } from '@agripinaa/exec-metrics';
import { useState } from 'react';

export function MevReceiptButton({ uid }: { uid: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  async function download() {
    setState('loading');
    try {
      const res = await fetch(`/api/exec/receipt/${uid}`);
      if (!res.ok) throw new Error(String(res.status));
      const { receipt } = (await res.json()) as { receipt: MevProofReceipt };
      const { filename, json } = exportReceiptJson(receipt);
      const url = URL.createObjectURL(
        new Blob([json], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      onClick={download}
      disabled={state === 'loading'}
      className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
      title="Download the settlement receipt (order, execution, surplus, fees) as JSON"
    >
      {state === 'loading' ? 'building…' : state === 'error' ? 'retry receipt' : 'receipt ↓'}
    </button>
  );
}
