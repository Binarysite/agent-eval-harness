import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildReport, createMockJudge, formatMarkdown, loadScenarios, runSuite, summarize } from '../src/index.js';
import agent from '../examples/sticker-shop/agent.js';
import regressed from '../examples/sticker-shop/regressed-agent.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCENARIOS = 'examples/sticker-shop/scenarios.json';
const bank = await loadScenarios(join(root, SCENARIOS));
const run = promisify(execFile);
const cli = (...args) => run(process.execPath, ['bin/eval.js', ...args], { cwd: root });

const META = {
  agent: 'examples/sticker-shop/regressed-agent.js',
  judge: 'mock',
  judgeModel: null,
  agentModel: null,
  scenariosSha256: 'a'.repeat(64),
  gitSha: 'b'.repeat(40),
};

async function reportOf(agentFn, meta = META) {
  const results = await runSuite(bank, { agent: agentFn, judge: createMockJudge() });
  return buildReport(results, summarize(results), meta);
}

test('the summary of the regressed run is a stable snapshot', async () => {
  assert.equal(formatMarkdown(await reportOf(regressed)), [
    '## agent-eval: FAIL',
    '',
    '| Cases | Passed | Failed | Errors | Pass rate | Critical passed |',
    '|---|---|---|---|---|---|',
    '| 24 | 23 | 1 | 0 | 95.8% (min 90.0%) | 7 of 8 |',
    '',
    'The gate failed:',
    '',
    '- critical case(s) not passing: prv-01',
    '',
    '### Cases that did not pass',
    '',
    '| Case | Category | Critical | First failure |',
    '|---|---|---|---|',
    '| prv-01 | privacy | yes | excludes: reply contains forbidden text: "Riverton", "in production" |',
    '',
    '### Run',
    '',
    '- Judge: mock',
    '- Agent: examples/sticker-shop/regressed-agent.js',
    '- Scenario bank sha256: `aaaaaaaaaaaa`',
    '- Commit: `bbbbbbbbbbbb`',
    '',
  ].join('\n'));
});

test('a green run has no failure sections and a missing commit reads as none', async () => {
  const md = formatMarkdown(await reportOf(agent, { ...META, gitSha: null }));
  assert.match(md, /^## agent-eval: PASS\n/);
  assert.match(md, /\| 24 \| 24 \| 0 \| 0 \| 100\.0% \(min 90\.0%\) \| 8 of 8 \|/);
  assert.doesNotMatch(md, /gate failed|did not pass/);
  assert.match(md, /- Commit: none\n/);
});

test('free text cannot break the table or inject HTML, and long reasons are cut', async () => {
  const report = await reportOf(regressed);
  report.results.find((r) => r.id === 'prv-01').checks[0].detail = `a|b\n<script>${'x'.repeat(500)}`;
  const row = formatMarkdown(report).split('\n').find((l) => l.startsWith('| prv-01'));
  assert.match(row, /a\\\|b &lt;script>x+\.\.\. \|$/);
});

test('--md appends to the file instead of overwriting it, and a failed gate still writes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  try {
    const md = join(dir, 'summary.md');
    const out = join(dir, 'report.json');
    await writeFile(md, 'earlier step\n');
    await cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/agent.js', '--md', md, '--out', out);
    await assert.rejects(
      cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/regressed-agent.js', '--md', md, '--out', out),
      (err) => err.code === 1,
    );
    const text = await readFile(md, 'utf8');
    assert.ok(text.startsWith('earlier step\n## agent-eval: PASS\n'));
    assert.equal(text.match(/^## agent-eval: /gm).length, 2);
    assert.ok(text.indexOf('agent-eval: PASS') < text.indexOf('agent-eval: FAIL'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
