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

test('warns when the two runs used a different judge, agent, bank or commit', () => {
  const meta = { judgeModel: 'j1', agentModel: null, scenariosSha256: 'aaa', gitSha: 'c1' };
  const before = { ...report(1, ['a', 'pass']), meta };
  const after = { ...report(1, ['a', 'pass']), meta: { ...meta, judgeModel: 'j2', scenariosSha256: 'bbb' } };
  const c = compareReports(before, after);
  assert.deepEqual(c.warnings, [
    'judgeModel differs between the runs: j1 -> j2',
    'scenariosSha256 differs between the runs: aaa -> bbb',
  ]);
  assert.match(formatComparison(c), /WARNING: judgeModel differs between the runs: j1 -> j2/);
  assert.deepEqual(compareReports(before, before).warnings, []);
  assert.deepEqual(compareReports(report(1), report(1)).warnings, [], 'reports without meta compare quietly');
});

test('warns when the two runs selected different cases or ran a different number of trials', () => {
  const full = { categories: [], criticalOnly: false };
  const before = { ...report(1, ['a', 'pass'], ['b', 'pass']), meta: { filters: full, options: { trials: 1 } } };
  const after = {
    ...report(1, ['a', 'pass']),
    meta: { filters: { ...full, criticalOnly: true }, options: { trials: 3 } },
  };
  const c = compareReports(before, after);
  assert.deepEqual(c.regressions.map((x) => x.id), ['b'], 'a case that disappeared still counts');
  assert.deepEqual(c.warnings, [
    'filters differ between the runs: {"categories":[],"criticalOnly":false} -> {"categories":[],"criticalOnly":true}',
    'trials differ between the runs: 1 -> 3',
  ]);
  assert.deepEqual(compareReports(before, before).warnings, []);
});
