import { test } from 'node:test';
import assert from 'node:assert/strict';
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
