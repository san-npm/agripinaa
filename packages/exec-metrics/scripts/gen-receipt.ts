/** Generate the evidence receipt JSON for a settled order uid. */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CowOrderbookClient } from '../src/cow';
import { buildReceipt } from '../src/receipt/build';
import { exportReceiptJson } from '../src/receipt/export';

const uid =
  process.argv[2] ??
  '0xa2fa52fa97922df8b884345a2959a71209a73957073098c4af76cbd72fa1f02b053fff26d28ff4e94dfe862b184f918a50c6f7066a848e4c';

const cow = new CowOrderbookClient();
const order = await cow.getOrder(uid);
const trades = await cow.getTrades({ orderUid: uid });
const receipt = buildReceipt({ order, trade: trades[0] ?? null, chainId: 56 });
const { filename, json } = exportReceiptJson(receipt);

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'docs', 'evidence', 'task1-receipt.json',
);
writeFileSync(out, json);
console.log(`wrote ${out} (canonical name ${filename})`);
