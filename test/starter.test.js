import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenarios } from '../src/index.js';
import agent from '../examples/starter/agent.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the starter bank is valid and its stub agent passes it from the CLI', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-starter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { code, stdout } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['bin/eval.js', '-s', 'examples/starter/scenarios.json', '-a', 'examples/starter/agent.js', '-o', join(dir, 's.json')],
      { cwd: root },
      (err, out) => resolve({ code: err ? err.code : 0, stdout: out }),
    );
  });
  assert.equal(code, 0);
  assert.match(stdout, /Total 3 {2}passed 3 {2}failed 0/);
  assert.match(stdout, /Critical 1 {2}passed 1/);
});

test('the starter replays a scripted history from context', async () => {
  const [, , history] = await loadScenarios(join(root, 'examples/starter/scenarios.json'));
  const out = await agent({ message: history.message, context: history.context, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(out.toolCalls, [{ name: 'cancel_order', args: { orderId: '1001' } }]);
});
