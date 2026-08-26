/** Raised as soon as a request body exceeds its byte budget. */
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Stream and byte-count an untrusted body instead of buffering it first. */
export async function readLimitedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('body too large');
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
