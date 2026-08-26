import assert from 'node:assert/strict';
import test from 'node:test';

import { readLimitedRequestText, RequestBodyTooLargeError } from '../src/lib/request-body';

test('limited request reader rejects a declared oversized body before reading it', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const request = new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-length': '9' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await assert.rejects(readLimitedRequestText(request, 8), RequestBodyTooLargeError);
});

test('limited request reader counts UTF-8 bytes while streaming', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('éé'));
      controller.close();
    },
  });
  const request = new Request('https://example.test', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await assert.rejects(readLimitedRequestText(request, 3), RequestBodyTooLargeError);
});
