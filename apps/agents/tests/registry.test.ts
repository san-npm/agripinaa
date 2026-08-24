/**
 * The guard the shared registry exists to provide.
 *
 * Adding an agent used to mean editing eight hand-maintained lists, and missing
 * one produced no error anywhere: the module ticked, but the agent had no token
 * id, no proof-feed identity, no manifest, no funding. These tests walk the
 * strategy modules on disk rather than a second hardcoded list, so a new module
 * with no registry record fails here instead of silently half-shipping.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AGENT_LIST, MANAGED_TOKENS, agentBySlug, routerFor } from '@agripinaa/shared';

import { managerKeyFile } from '../src/manager-key';
import type { AgentModule } from '../src/types';

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents');

function isAgentModule(value: unknown): value is AgentModule {
  if (typeof value !== 'object' || value === null) return false;
  const module = value as Partial<AgentModule>;
  return (
    typeof module.name === 'string' &&
    typeof module.category === 'string' &&
    typeof module.tick === 'function' &&
    typeof module.status === 'function'
  );
}

/** Every strategy module under src/agents, i.e. what runner.ts collects in ALL. */
async function loadModules(): Promise<AgentModule[]> {
  const files = readdirSync(AGENTS_DIR).filter((file) => file.endsWith('.ts'));
  const modules: AgentModule[] = [];
  for (const file of files) {
    const exported = (await import(pathToFileURL(join(AGENTS_DIR, file)).href)) as Record<
      string,
      unknown
    >;
    const found = Object.values(exported).filter(isAgentModule);
    assert.equal(found.length, 1, `${file} should export exactly one AgentModule`);
    modules.push(found[0]!);
  }
  return modules;
}

test('every strategy module the runner hosts has a registry record', async () => {
  const modules = await loadModules();
  assert.ok(modules.length > 0, 'no strategy modules found');
  for (const module of modules) {
    const record = agentBySlug(module.name);
    assert.ok(record, `agent module "${module.name}" has no record in @agripinaa/shared agents.ts`);
    assert.equal(
      record.category,
      module.category,
      `${module.name}: strategy category disagrees with the registry`,
    );
  }
});

test('every registry record has a strategy module to tick it', async () => {
  const names = new Set((await loadModules()).map((module) => module.name));
  for (const record of AGENT_LIST) {
    assert.ok(names.has(record.slug), `${record.slug}: in the registry but has no strategy module`);
  }
});

test('every managed agent is reachable by the managed-funds path', async () => {
  const names = new Set((await loadModules()).map((module) => module.name));
  const managed = AGENT_LIST.filter((record) => record.managed);
  assert.ok(managed.length > 0, 'no agent is marked as managing user funds');
  for (const record of managed) {
    assert.ok(names.has(record.slug), `${record.slug}: managed but has no strategy module to tick`);
    // The runner loads this file to sign router calls; fund --gen creates it
    // under exactly this name. A mismatch disables managed mode silently.
    assert.equal(
      basename(managerKeyFile(record.slug)),
      `agent-${record.slug}-session.json`,
      `${record.slug}: manager key file does not match the session wallet name`,
    );
    // Users grant a session scoped to a router, one per managed stablecoin.
    // Without a deployment there is nothing safe to scope the grant to.
    for (const symbol of MANAGED_TOKENS) {
      assert.ok(
        routerFor(record.manifest.execution.chainId, symbol),
        `${record.slug}: no drain-proof router deployed for ${symbol}`,
      );
    }
  }
});
