'use client';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  title: string;
  detail?: string;
  kind: ToastKind;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
let seq = 0;

function emit() {
  for (const l of listeners) l(toasts);
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  l(toasts);
  return () => listeners.delete(l);
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Fire a toast from anywhere in the client. Auto-dismisses. */
export function toast(input: { title: string; detail?: string; kind?: ToastKind }) {
  const item: ToastItem = {
    id: ++seq,
    title: input.title,
    detail: input.detail,
    kind: input.kind ?? 'info',
  };
  toasts = [...toasts, item].slice(-4); // cap the stack
  emit();
  setTimeout(() => dismissToast(item.id), 3800);
}
