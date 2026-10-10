import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The README shows real output. These tests rerun the same commands and fail when a
// block marked `<!-- output: name -->` is no longer what the harness prints.

const root = fileURLToPath(new URL('..', import.meta.url));
const SCENARIOS = 'examples/sticker-shop/scenarios.json';

/** Run the CLI and resolve with its exit code and stdout, whatever the exit code. */
const cli = (...args) => new Promise((resolve) => {
  execFile(process.execPath, ['bin/eval.js', ...args], { cwd: root }, (err, stdout) => {
    resolve({ code: err ? err.code : 0, stdout });
  });
});

/** The text block that follows `<!-- output: name -->` in the README, as lines. */
async function readmeBlock(name) {
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const marker = `<!-- output: ${name} -->\n\`\`\`text\n`;
  const start = readme.indexOf(marker);
  assert.notEqual(start, -1, `README has no block marked "output: ${name}"`);
  const body = readme.slice(start + marker.length, readme.indexOf('\n```', start + marker.length));
  return body.split('\n');
}

/** Every non-empty README line appears in the real output, in the same order. */
function assertShownIn(blockLines, stdout) {
  const real = stdout.split('\n').map((l) => l.trimEnd());
  let at = 0;
  for (const line of blockLines.map((l) => l.trimEnd()).filter(Boolean)) {
    const found = real.indexOf(line, at);
    assert.notEqual(found, -1, `README line not in the real output (or out of order): ${line}`);
    at = found + 1;
  }
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-readme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('README eval:regression block matches a real run, which exits 1', async (t) => {
  const dir = await tempDir(t);
  const run = await cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/regressed-agent.js', '-o', join(dir, 'r.json'));
  assert.equal(run.code, 1);
  assertShownIn(await readmeBlock('eval:regression'), run.stdout);
});

test('README compare block matches a real compare, which exits 1', async (t) => {
  const dir = await tempDir(t);
  const main = join(dir, 'main.json');
  const branch = join(dir, 'branch.json');
  assert.equal((await cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/agent.js', '-o', main)).code, 0);
  assert.equal((await cli('-s', SCENARIOS, '-a', 'examples/sticker-shop/regressed-agent.js', '-o', branch)).code, 1);
  const run = await cli('compare', main, branch);
  assert.equal(run.code, 1);
  assertShownIn(await readmeBlock('compare'), run.stdout);
});
