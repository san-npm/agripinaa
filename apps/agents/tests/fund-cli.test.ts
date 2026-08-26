import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFundingArgs } from '../src/fund-cli';

test('funding defaults to a plan and preserves an exact --only selection', () => {
  assert.deepEqual(parseFundingArgs([]), { mode: '--plan', only: undefined });
  assert.deepEqual(parseFundingArgs(['--execute', '--only', 'agent-grid']), {
    mode: '--execute',
    only: 'agent-grid',
  });
});

test('a misspelled funding flag stops before execution can widen to every wallet', () => {
  assert.throws(
    () => parseFundingArgs(['--execute', '--onyl', 'agent-grid']),
    /unknown option --onyl/,
  );
});

test('conflicting and repeated funding modes are rejected', () => {
  assert.throws(() => parseFundingArgs(['--plan', '--execute']), /funding modes conflict/);
  assert.throws(() => parseFundingArgs(['--execute', '--execute']), /--execute given twice/);
});
