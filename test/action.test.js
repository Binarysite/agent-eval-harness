import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const action = await readFile(join(root, 'action.yml'), 'utf8');
const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');

/** The `run: |` block of the action's script step, dedented. */
function scriptOf(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === '      run: |');
  assert.notEqual(start, -1, 'action.yml has no run block');
  return lines.slice(start + 1).filter((l) => l.startsWith('        ')).map((l) => l.slice(8)).join('\n');
}

const pinOf = (yml, name) => yml.match(new RegExp(`uses: (actions/${name}@[0-9a-f]{40}) # v`))?.[1];

test('the action pins setup-node to the same commit as the CI', () => {
  assert.ok(pinOf(action, 'setup-node'), 'setup-node is pinned by commit');
  assert.equal(pinOf(action, 'setup-node'), pinOf(ci, 'setup-node'));
});

test('the action declares its inputs and keeps them out of the script text', () => {
  assert.match(action, /scenarios:\n {4}description: .*\n {4}required: true/);
  assert.match(action, /agent:\n {4}description: .*\n {4}required: true/);
  assert.match(action, /judge:[\s\S]*?default: mock/);
  assert.match(action, /node-version:[\s\S]*?default: '22'/);
  assert.doesNotMatch(scriptOf(action), /\$\{\{/);
});

test('the action script runs the gate, appends the summary and passes the exit code through', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary.md');
  const script = scriptOf(action);
  const env = (agent, extra = {}) => ({
    PATH: process.env.PATH,
    GITHUB_ACTION_PATH: root,
    GITHUB_STEP_SUMMARY: summary,
    EVAL_SCENARIOS: 'examples/sticker-shop/scenarios.json',
    EVAL_AGENT: `examples/sticker-shop/${agent}`,
    EVAL_JUDGE: 'mock',
    EVAL_MIN_PASS_RATE: '',
    EVAL_ARGS: `-o ${join(dir, 'report.json')}`,
    ...extra,
  });
  const bash = (e) => run('bash', ['-c', script], { cwd: root, env: e });

  const ok = await bash(env('agent.js', { EVAL_MIN_PASS_RATE: '0.5', EVAL_ARGS: `--trials 2 -o ${join(dir, 'report.json')}` }));
  assert.match(ok.stdout, /RESULT: PASS/);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.deepEqual([report.meta.options.trials, report.summary.minPassRate], [2, 0.5]);

  await assert.rejects(bash(env('regressed-agent.js')), (err) => err.code === 1 && /RESULT: FAIL/.test(err.stdout));
  const text = await readFile(summary, 'utf8');
  assert.deepEqual(text.match(/^## agent-eval: \w+/gm), ['## agent-eval: PASS', '## agent-eval: FAIL']);
});
