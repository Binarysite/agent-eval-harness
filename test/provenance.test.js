import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runProvenance, gitSha } from '../src/provenance.js';
import { createAnthropicJudge, createOpenAICompatibleJudge } from '../src/judges/llm.js';
import { createMockJudge } from '../src/judges/mock.js';

const BANK = new URL('../examples/sticker-shop/scenarios.json', import.meta.url);

test('provenance records the models, the bank hash and the commit', async () => {
  const agent = Object.assign(async () => ({ reply: 'x' }), { model: 'agent-model' });
  const judge = createAnthropicJudge({ apiKey: 'k', model: 'judge-model' });
  const p = await runProvenance({ agent, judge, scenariosFile: BANK });
  assert.equal(p.judgeModel, 'judge-model');
  assert.equal(p.agentModel, 'agent-model');
  assert.equal(p.scenariosSha256, createHash('sha256').update(await readFile(BANK)).digest('hex'));
  assert.ok(p.gitSha === null || /^[0-9a-f]{40,64}$/.test(p.gitSha), String(p.gitSha));
  assert.equal(createOpenAICompatibleJudge({ apiKey: 'k', model: 'm' }).model, 'm');
});

test('anything not exposed is null, not a guess', async () => {
  const p = await runProvenance({ agent: async () => ({ reply: 'x' }), judge: createMockJudge() });
  assert.deepEqual([p.judgeModel, p.agentModel, p.scenariosSha256], [null, null, null]);
});

test('gitSha is null outside a repository instead of throwing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
  t.after(async () => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(gitSha(dir), null);
  assert.equal(gitSha(join(dir, 'does-not-exist')), null);
});
