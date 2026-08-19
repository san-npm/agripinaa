'use client';

import { exportReceiptJson, type MevProofReceipt } from '@agripinaa/exec-metrics';
import { useState } from 'react';

import { toast } from '@/lib/toast';

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
      toast({ title: 'Receipt downloaded', detail: filename, kind: 'success' });
    } catch {
      setState('error');
      toast({ title: 'Could not build receipt', kind: 'error' });
    }
  }

  return (
    <button
      onClick={download}
      disabled={state === 'loading'}
      className="rounded border border-border-strong px-2 py-0.5 text-xs text-muted transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
      title="Download the settlement receipt (order, execution, surplus, fees) as JSON"
    >
      {state === 'loading' ? 'building…' : state === 'error' ? 'retry receipt' : 'receipt ↓'}
    </button>
  );
}
