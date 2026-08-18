/**
 * Headless port of the Ophis frontend receipt JSON exporter
 * (mevReceipt/services/exportJson.ts + the download filename convention).
 */

import type { MevProofReceipt } from './build';

export interface ReceiptExport {
  filename: string;
  json: string;
}

/**
 * Stable, indented JSON: object keys are sorted recursively so two receipts
 * with the same data serialize byte-identically (useful for accounting
 * reconciliation and content hashing). Arrays keep their order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      if (Array.isArray(entry)) return entry;
      const sorted: Record<string, unknown> = {};
      Object.keys(entry)
        .sort()
        .forEach((k) => {
          sorted[k] = (entry as Record<string, unknown>)[k];
        });
      return sorted;
    },
    2,
  );
}

export function exportReceiptJson(receipt: MevProofReceipt): ReceiptExport {
  const shortUid = receipt.orderUid.slice(0, 10);
  return {
    filename: `ophis-receipt-${shortUid}.json`,
    json: stableStringify(receipt),
  };
}
