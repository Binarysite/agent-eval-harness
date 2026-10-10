import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('text from the agent cannot become a live link, image or code span, and a backslash cannot eat the pipe', async () => {
  const report = await reportOf(regressed);
  const check = report.results.find((r) => r.id === 'prv-01').checks[0];
  const rowOf = () => formatMarkdown(report).split('\n').find((l) => l.startsWith('| prv-01'));
  check.detail = String.raw`C:\x\ ![x](https://evil.example/p.png) [click](https://evil.example) ` + '`x` <b>';
  assert.ok(rowOf().includes(String.raw`C:\\x\\ \!\[x\](https\://evil.example/p.png) \[click\](https\://evil.example) \`x\` &lt;b> |`));
  check.detail = 'ends with a backslash \\';
  assert.ok(rowOf().endsWith('backslash \\\\ |'));
});

test('a report without warnings or flaky cases, built by hand or by an older version, still formats', async () => {
  const report = await reportOf(regressed);
  const { warnings, flaky, ...older } = report.summary;
  assert.match(formatMarkdown({ ...report, summary: older }), /^## agent-eval: FAIL\n/);
});

test('a bare URL, www address or email from the agent is not autolinked', async () => {
  const report = await reportOf(regressed);
  report.results.find((r) => r.id === 'prv-01').error = 'visit https://evil.example/login, HTTP://x.example, www.evil.example or bob@evil.example';
  const row = formatMarkdown(report).split('\n').find((l) => l.startsWith('| prv-01'));
  // GitHub renders these as plain text: checked against its /markdown API in gfm mode.
  assert.ok(row.includes(String.raw`visit https\://evil.example/login, HTTP\://x.example, www\.evil.example or bob` + '​@evil.example |'), row);
});

test('an API key in an error is redacted, and the judge reason stays out of the summary', async () => {
  const report = await reportOf(regressed);
  const failing = report.results.find((r) => r.id === 'prv-01');
  failing.error = 'upstream said Bearer sk-ant-api03-SECRETSECRET1234 rejected';
  const withKey = formatMarkdown(report);
  assert.doesNotMatch(withKey, /SECRETSECRET/);
  assert.match(withKey, /error: upstream said Bearer \\\[redacted\\\] rejected/);

  failing.error = undefined;
  failing.checks = failing.checks.map((c) => ({ ...c, pass: true }));
  failing.verdict = { pass: false, reason: 'The reply "Hola Juan Perez, RUT 12.345.678-9" leaks PII' };
  const md = formatMarkdown(report);
  assert.doesNotMatch(md, /Juan Perez|12\.345/);
  assert.match(md, /judge: no passing verdict/);
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

test('--md creates missing folders, a bad folder exits 2 before the run, and a failed append keeps the gate exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  try {
    const out = join(dir, 'report.json');
    const nested = join(dir, 'new', 'deeper', 's.md');
    await cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/agent.js', '--md', nested, '--out', out);
    assert.match(await readFile(nested, 'utf8'), /^## agent-eval: PASS\n/);

    // A folder that cannot be created is a setup error, raised before any case runs.
    const aFile = join(dir, 'a-file');
    await writeFile(aFile, '');
    await assert.rejects(
      cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/agent.js', '--md', join(aFile, 's.md'), '--out', out),
      (err) => err.code === 2 && !/RESULT:/.test(err.stdout),
    );

    // A directory cannot be appended to: the gate still decides the exit code.
    const asDir = join(dir, 'a-folder');
    await mkdir(asDir);
    const ok = await cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/agent.js', '--md', asDir, '--out', out);
    assert.match(ok.stderr, /could not write the summary/);
    await assert.rejects(
      cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/regressed-agent.js', '--md', asDir, '--out', out),
      (err) => err.code === 1 && /could not write the summary/.test(err.stderr),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
