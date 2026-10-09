import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarios, validateScenarios, filterScenarios } from '../src/scenarios.js';

const BANK = new URL('../examples/sticker-shop/scenarios.json', import.meta.url);

test('the example bank is valid and shaped as documented', async () => {
  const bank = await loadScenarios(BANK);
  const categories = new Set(bank.map((s) => s.category));
  const critical = bank.filter((s) => s.critical);
  assert.equal(bank.length, 24);
  assert.ok(categories.size >= 8 && categories.size <= 10, `${categories.size} categories`);
  assert.ok(critical.length >= 6 && critical.length <= 8, `${critical.length} critical`);
});

test('validation collects every problem in one error', () => {
  const bad = [
    { id: 'a', category: 'x', message: 'hi', expect: { exclude: ['typo'] } },
    { id: 'a', category: '', message: 'hi', rubric: 'r' },
    { id: 'c', category: 'x', message: 'hi' },
    { id: 'd', category: 'x', message: 'hi', critical: 'yes', expect: { tools: [] } },
  ];
  assert.throws(() => validateScenarios(bad), (err) => {
    const fragments = [
      'unknown expectation "exclude"',
      'duplicate id',
      '"category" must be',
      'needs "expect"',
      '"critical" must be boolean',
      '"tools" must be a non-empty array',
    ];
    for (const fragment of fragments) {
      assert.ok(err.message.includes(fragment), `missing: ${fragment}`);
    }
    return true;
  });
  assert.throws(() => validateScenarios({}), /JSON array/);
});

test('an empty expect block without a rubric is rejected, not a free pass', () => {
  const one = (fields) => [{ id: 'a', category: 'x', message: 'hi', ...fields }];
  assert.throws(() => validateScenarios(one({ expect: {} })), /needs "expect" rules/);
  assert.throws(() => validateScenarios(one({ expect: null })), /"expect" must be an object/);
  assert.doesNotThrow(() => validateScenarios(one({ expect: {}, rubric: 'r' })));
});

test('toolArgs must map each tool to an argument object', () => {
  for (const toolArgs of [null, [], {}, { lookup_order: null }, { lookup_order: '10482' }]) {
    const bank = [{ id: 'a', category: 'x', message: 'hi', expect: { toolArgs } }];
    assert.throws(() => validateScenarios(bank), /"toolArgs" must map tool names/, JSON.stringify(toolArgs));
  }
  const valid = [{ id: 'a', category: 'x', message: 'hi', expect: { toolArgs: { t: { k: 1 } } } }];
  assert.doesNotThrow(() => validateScenarios(valid));
});

test('invalid JSON names the file it came from', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  const file = join(dir, 'broken.json');
  try {
    await writeFile(file, '[{ "id": "a", }]');
    await assert.rejects(loadScenarios(file), (err) => err.message.startsWith(`${file}: invalid JSON: `));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filters by category and critical flag', () => {
  const bank = [
    { id: '1', category: 'a', critical: true },
    { id: '2', category: 'a' },
    { id: '3', category: 'b', critical: true },
  ];
  assert.deepEqual(filterScenarios(bank, { categories: ['a'] }).map((s) => s.id), ['1', '2']);
  assert.deepEqual(filterScenarios(bank, { criticalOnly: true }).map((s) => s.id), ['1', '3']);
  assert.deepEqual(filterScenarios(bank, { categories: ['a'], criticalOnly: true }).map((s) => s.id), ['1']);
});

test('a critical case needs a deterministic rule, not a rubric alone', () => {
  const one = (fields) => [{ id: 'a', category: 'x', message: 'hi', critical: true, ...fields }];
  assert.throws(() => validateScenarios(one({ rubric: 'r' })), /a critical case needs at least one "expect" rule/);
  assert.throws(() => validateScenarios(one({ expect: {}, rubric: 'r' })), /a critical case needs at least one/);
  assert.doesNotThrow(() => validateScenarios(one({ expect: { excludes: ['leak'] }, rubric: 'r' })));
  assert.doesNotThrow(() => validateScenarios(one({ critical: false, rubric: 'r' })));
});

test('list rules accept only non-empty strings', () => {
  const bad = [
    ['includesAny', ['']], ['excludes', ['ok', '  ']], ['tools', [1]], ['noTools', [null]], ['includesAny', 'x'],
  ];
  for (const [key, value] of bad) {
    const bank = [{ id: 'a', category: 'x', message: 'hi', expect: { [key]: value } }];
    const message = new RegExp(`"${key}" must be a non-empty array of non-empty strings`);
    assert.throws(() => validateScenarios(bank), message, `${key}: ${JSON.stringify(value)}`);
  }
});

test('a misspelled scenario field is an error, so "critcal" cannot demote a release blocker', () => {
  const one = (fields) => [{ id: 'a', category: 'x', message: 'hi', expect: { anyTool: false }, ...fields }];
  assert.throws(() => validateScenarios(one({ critcal: true })), /unknown field "critcal"/);
  assert.throws(() => validateScenarios(one({ rubrik: 'r', expects: {} })), (err) => {
    assert.match(err.message, /unknown field "rubrik"/);
    assert.match(err.message, /unknown field "expects"/);
    return true;
  });
});

test('context must be an object and a rubric must have text', () => {
  const one = (fields) => [{ id: 'a', category: 'x', message: 'hi', expect: { anyTool: false }, ...fields }];
  for (const context of ['x', [1], null]) {
    assert.throws(() => validateScenarios(one({ context })), /"context" must be an object/, JSON.stringify(context));
  }
  assert.throws(() => validateScenarios(one({ expect: undefined, rubric: '   ' })), /"rubric" must be a non-empty string/);
});

test('a file that is not a JSON array is named in the error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-'));
  const file = join(dir, 'object.json');
  try {
    await writeFile(file, '{ "id": "a" }');
    await assert.rejects(loadScenarios(file), (err) => err.message === `${file}: must contain a JSON array of scenarios`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
