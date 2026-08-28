import { agentBySlug } from '@agripinaa/shared/agents';
import { isAddress } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

import {
  kvAcquireSessionGrantLease,
  kvReleaseSessionGrantLease,
} from '@/lib/kv';

const PUBLIC_KEY_RE = /^0x04[0-9a-fA-F]{128}$/;
const TOKEN_RE = /^0x[0-9a-fA-F]{64}$/;
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const LEASE_MS = 30_000;

function identity(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (
    typeof value['account'] !== 'string'
    || !isAddress(value['account'])
    || typeof value['agent'] !== 'string'
    || typeof value['publicKey'] !== 'string'
    || !PUBLIC_KEY_RE.test(value['publicKey'])
    || typeof value['leaseToken'] !== 'string'
    || !TOKEN_RE.test(value['leaseToken'])
  ) return null;
  const agent = agentBySlug(value['agent']);
  if (!agent?.managed) return null;
  const manager = publicKeyToAddress(value['publicKey'] as `0x${string}`);
  if (!Object.values(agent.managerKeys ?? {}).some((address) =>
    address?.toLowerCase() === manager.toLowerCase())) return null;
  return {
    account: value['account'].toLowerCase(),
    agent: value['agent'],
    manager: manager.toLowerCase(),
    publicKey: value['publicKey'].toLowerCase(),
    leaseToken: value['leaseToken'].toLowerCase(),
    expiry: value['expiry'],
  };
}

function keys(value: NonNullable<ReturnType<typeof identity>>) {
  const base = `session-grant:${value.account}:${value.agent}`;
  return { bindingKey: `${base}:manager`, leaseKey: `${base}:lease` };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid request' }, { status: 400 });
  }
  const value = identity(body);
  if (!value || typeof value.expiry !== 'number' || !Number.isSafeInteger(value.expiry)) {
    return Response.json({ error: 'invalid request' }, { status: 400 });
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (value.expiry <= nowSeconds || value.expiry > nowSeconds + MAX_SESSION_SECONDS + 300) {
    return Response.json({ error: 'invalid session expiry' }, { status: 400 });
  }
  const grantKeys = keys(value);
  const result = await kvAcquireSessionGrantLease({
    ...grantKeys,
    manager: value.publicKey,
    leaseToken: value.leaseToken,
    bindingTtlMs: (value.expiry - nowSeconds + 24 * 60 * 60) * 1_000,
    leaseTtlMs: LEASE_MS,
  });
  if (result === 'acquired') return Response.json({ acquired: true }, { status: 201 });
  if (result === 'busy') return Response.json({ error: 'another activation is submitting' }, { status: 409 });
  if (result === 'manager-conflict') {
    return Response.json({ error: 'a previous manager binding may still be live' }, { status: 409 });
  }
  return Response.json({ error: 'shared activation lock unavailable' }, { status: 503 });
}

export async function DELETE(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ released: false }, { status: 400 });
  }
  const value = identity(body);
  if (!value) return Response.json({ released: false }, { status: 400 });
  await kvReleaseSessionGrantLease(keys(value).leaseKey, value.leaseToken);
  return Response.json({ released: true });
}
