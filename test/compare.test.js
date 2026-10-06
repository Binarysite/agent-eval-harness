import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, formatComparison } from '../src/compare.js';

const report = (passRate, ...results) => ({
  summary: { passRate },
  results: results.map(([id, status, critical = false]) => ({ id, status, critical })),
});

test('lists only the cases that changed status and flags regressions', () => {
  const before = report(0.75, ['a', 'pass'], ['b', 'pass', true], ['c', 'fail'], ['d', 'pass']);
  const after = report(0.75, ['a', 'pass'], ['b', 'fail', true], ['c', 'pass'], ['e', 'pass']);
  const c = compareReports(before, after);
  assert.deepEqual(
    c.changes.map((x) => `${x.id}:${x.from}->${x.to}`),
    ['b:pass->fail', 'c:fail->pass', 'd:pass->missing', 'e:missing->pass'],
  );
  assert.deepEqual(c.regressions.map((x) => x.id), ['b', 'd']);
  const text = formatComparison(c);
  assert.match(text, /pass {4}-> fail {4}b {2}\[critical\]/);
  assert.match(text, /regressions 2$/);
});

test('identical runs report no changes', () => {
  const r = report(1, ['a', 'pass']);
  assert.match(formatComparison(compareReports(r, r)), /^No case changed status\./);
});

test('a file that is not a report is rejected by name', () => {
  const r = report(1, ['a', 'pass']);
  assert.throws(
    () => compareReports({ hello: 'world' }, r, { beforeLabel: 'main.json' }),
    /main\.json is not an agent-eval report/,
  );
});
