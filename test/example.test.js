import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadScenarios, runSuite, summarize, createMockJudge } from '../src/index.js';
import { RUN_DEFAULTS } from '../src/runner.js';
import { MIN_PASS_RATE } from '../src/report.js';
import { HANDOFF_TOOL } from '../src/expectations.js';
import agent from '../examples/sticker-shop/agent.js';
import regressed from '../examples/sticker-shop/regressed-agent.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCENARIOS = 'examples/sticker-shop/scenarios.json';
const AGENT = 'examples/sticker-shop/agent.js';
const REGRESSED = 'examples/sticker-shop/regressed-agent.js';
const bank = await loadScenarios(join(root, SCENARIOS));
const run = promisify(execFile);
const cli = (...args) => run(process.execPath, ['bin/eval.js', ...args], { cwd: root });

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the example agent passes the whole bank', async () => {
  const results = await runSuite(bank, { agent, judge: createMockJudge() });
  const s = summarize(results);
  assert.deepEqual(results.filter((r) => r.status !== 'pass').map((r) => r.id), []);
  assert.equal(s.gate.pass, true);
});

test('the regressed agent leaks one order and the critical gate catches it', async () => {
  const s = summarize(await runSuite(bank, { agent: regressed, judge: createMockJudge() }));
  assert.equal(s.passed, 23);
  assert.ok(s.passRate >= s.minPassRate, 'pass rate alone would have shipped it');
  assert.deepEqual(s.critical.failures, ['prv-01']);
  assert.equal(s.gate.pass, false);
});

test('CLI exits 0 on a green run, 1 on a gate failure and writes the JSON report', async (t) => {
  const out = join(await tempDir(t), 'report.json');
  await cli('-s', SCENARIOS, '-a', AGENT, '--out', out);
  const report = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(report.summary.gate.pass, true);
  assert.equal(report.results.length, 24);
  assert.match(report.meta.scenariosSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([report.meta.judgeModel, report.meta.agentModel], [null, null]);
  assert.ok('gitSha' in report.meta);

  await cli('-s', SCENARIOS, '-a', AGENT, '--trials', '2', '--out', out);
  const twice = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(twice.meta.options.trials, 2);
  assert.ok(twice.results.every((r) => r.trials.run === 2 && !r.flaky));

  await assert.rejects(
    cli('-s', SCENARIOS, '-a', REGRESSED, '--critical', '--out', out),
    (err) => err.code === 1 && /critical case\(s\) not passing: prv-01/.test(err.stdout),
  );
});

test('the report records paths relative to the working directory, never absolute ones', async (t) => {
  const out = join(await tempDir(t), 'report.json');
  await cli('-s', join(root, SCENARIOS), '-a', join(root, AGENT), '-c', 'privacy', '--out', out);
  const { meta } = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual([meta.scenarios, meta.agent], [SCENARIOS, AGENT]);
});

test('CLI --help shows the library defaults', async () => {
  const { stdout } = await cli('--help');
  for (const [flag, value] of [
    ['--concurrency', RUN_DEFAULTS.concurrency], ['--retries', RUN_DEFAULTS.retries],
    ['--trials', RUN_DEFAULTS.trials], ['--timeout', RUN_DEFAULTS.timeoutMs],
    ['--min-pass-rate', MIN_PASS_RATE], ['--handoff-tool', HANDOFF_TOOL],
  ]) {
    const line = stdout.split('\n').findIndex((l) => l.includes(flag));
    const block = stdout.split('\n').slice(line, line + 2).join(' ');
    assert.match(block, new RegExp(`\\(default ${value}\\)`), flag);
  }
});

test('CLI setup errors exit 2', async (t) => {
  const noDefault = join(await tempDir(t), 'named-only.js');
  await writeFile(noDefault, 'export const agent = async () => ({ reply: "x" });\n');
  const cases = [
    [['-s', SCENARIOS], /--scenarios and --agent are required/],
    [['-s', SCENARIOS, '-a', noDefault], /must export the agent as default/],
    [['-s', SCENARIOS, '-a', AGENT, '--retries', '1.5'], /--retries must be an integer/],
    [['-s', SCENARIOS, '-a', AGENT, '--trials', '0'], /--trials must be an integer between 1/],
    [['-s', SCENARIOS, '-a', AGENT, '--judge', 'nope'], /unknown judge "nope"/],
    [['-s', SCENARIOS, '-a', AGENT, '--bogus'], /Unknown option '--bogus'.*\(see agent-eval --help\)/],
    [['-s', SCENARIOS, '-a', AGENT, '-c', 'privacy,privcy'], /unknown category "privcy" \(categories: .*privacy/],
  ];
  for (const [args, message] of cases) {
    await assert.rejects(cli(...args), (err) => err.code === 2 && message.test(err.stderr), args.join(' '));
  }
});

test('CLI filters by category, prints replies with -v and compares two reports', async (t) => {
  const dir = await tempDir(t);
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  const { stdout } = await cli('-s', SCENARIOS, '-a', AGENT, '-c', 'privacy', '-v', '--out', good);
  assert.match(stdout, /3 scenarios/);
  assert.match(stdout, /reply: I can only share details about orders on your own account/);
  assert.doesNotMatch(stdout, /order_status/);

  await assert.rejects(cli('-s', SCENARIOS, '-a', REGRESSED, '-c', 'privacy', '--out', bad), (err) => err.code === 1);
  await assert.rejects(
    cli('compare', good, bad),
    (err) => err.code === 1 && /pass {4}-> fail {4}prv-01 {2}\[critical\]/.test(err.stdout),
  );
  const same = await cli('compare', good, good);
  assert.match(same.stdout, /No case changed status/);
  await assert.rejects(cli('compare', good), (err) => err.code === 2);

  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ nope');
  await assert.rejects(
    cli('compare', good, broken),
    (err) => err.code === 2 && err.stderr.includes(`${broken}: invalid JSON`),
  );
  const help = await cli('compare', '--help');
  assert.match(help.stdout, /agent-eval compare <before\.json> <after\.json>/);
});
