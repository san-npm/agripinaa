'use client';

import { useEffect, useState } from 'react';

import { dismissToast, subscribeToasts, type ToastItem } from '@/lib/toast';
import { LightningIcon, VerifiedIcon } from './icons';

function ToastIcon({ kind }: { kind: ToastItem['kind'] }) {
  if (kind === 'success') return <VerifiedIcon className="h-5 w-5 text-success" />;
  if (kind === 'error') return <LightningIcon className="h-5 w-5 text-danger" />;
  return <LightningIcon className="h-5 w-5 text-primary" />;
}

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="agp-toast pointer-events-auto flex items-start gap-3 rounded-xl border border-border-strong bg-surface/95 p-3.5 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.6)] backdrop-blur-md"
        >
          <span className="mt-0.5 shrink-0">
            <ToastIcon kind={t.kind} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t.title}</p>
            {t.detail && (
              <p className="mt-0.5 truncate text-xs text-muted-2">{t.detail}</p>
            )}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="shrink-0 text-muted-2 transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
