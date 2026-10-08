import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, formatCase, formatSummary } from '../src/report.js';

const result = (id, status, critical = false, category = 'c') => ({
  id, status, critical, category, checks: [], verdict: null, attempts: 1,
});
const many = (n, status) => Array.from({ length: n }, (_, i) => result(`r${i}`, status));

test('a failing critical case fails the run even at a high pass rate', () => {
  const s = summarize([...many(23, 'pass'), result('leak', 'fail', true)], { minPassRate: 0.9 });
  assert.ok(s.passRate > 0.95);
  assert.equal(s.gate.pass, false);
  assert.deepEqual(s.critical.failures, ['leak']);
  assert.match(s.gate.reasons[0], /critical case\(s\) not passing: leak/);
});

test('a critical case that errors counts as not passing', () => {
  const s = summarize([...many(9, 'pass'), result('c1', 'error', true)], { minPassRate: 0 });
  assert.equal(s.gate.pass, false);
  assert.equal(s.errors, 1);
});

test('the pass rate threshold applies on its own', () => {
  const s = summarize([...many(8, 'pass'), ...many(2, 'fail')], { minPassRate: 0.9 });
  assert.equal(s.gate.pass, false);
  assert.match(s.gate.reasons[0], /80.0% is below the minimum 90.0%/);
  assert.equal(summarize([...many(9, 'pass'), result('x', 'fail')], { minPassRate: 0.9 }).gate.pass, true);
});

test('an empty selection never passes', () => {
  assert.deepEqual(summarize([]).gate, { pass: false, reasons: ['no scenarios selected'] });
});

test('per-category counts', () => {
  const s = summarize([
    result('a', 'pass', false, 'x'),
    result('b', 'fail', false, 'x'),
    result('c', 'pass', false, 'y'),
  ]);
  assert.deepEqual({ ...s.byCategory }, { x: { total: 2, passed: 1 }, y: { total: 1, passed: 1 } });
});

test('console output names the failing rule and the gate reason', () => {
  const leak = { rule: 'excludes', pass: false, detail: 'reply contains forbidden text: "Riverton"' };
  const r = { ...result('prv-01', 'fail', true, 'privacy'), checks: [leak] };
  const line = formatCase(r);
  assert.match(line, /^FAIL {2}privacy\s+prv-01 {2}\[critical\]/);
  assert.match(line, /- excludes: reply contains forbidden text/);
  assert.match(formatSummary(summarize([r])), /RESULT: FAIL\n {2}- critical case\(s\) not passing: prv-01/);
});

test('warns when nothing is critical or a pass checked nothing', () => {
  const unchecked = summarize([result('a', 'pass')]);
  assert.equal(unchecked.gate.pass, true);
  assert.match(unchecked.warnings[0], /no critical cases/);
  assert.match(unchecked.warnings[1], /no rule and no real judge.*: a/);
  assert.match(formatSummary(unchecked), /WARNING: no critical cases/);
  const checked = { ...result('b', 'pass', true), checks: [{ rule: 'tools', pass: true, detail: '' }] };
  assert.deepEqual(summarize([checked]).warnings, []);
});

test('a critical case that passed on the rubric alone without a real judge fails the gate', () => {
  const mockVerdict = { pass: true, reason: 'mock heuristics passed', graded: false, attempts: 1 };
  const rubricOnly = { ...result('crit', 'pass', true), verdict: mockVerdict };
  const s = summarize([...many(9, 'pass'), rubricOnly], { minPassRate: 0 });
  assert.equal(s.gate.pass, false);
  assert.match(s.gate.reasons.join('\n'), /passed on the rubric alone with no real judge.*: crit$/);

  const noJudge = { ...rubricOnly, verdict: { pass: null, reason: 'no judge', graded: false, attempts: 0 } };
  assert.equal(summarize([noJudge], { minPassRate: 0 }).gate.pass, false);

  const realJudge = { ...rubricOnly, verdict: { ...mockVerdict, graded: true } };
  assert.equal(summarize([realJudge], { minPassRate: 0 }).gate.pass, true);
  const withRule = { ...rubricOnly, checks: [{ rule: 'excludes', pass: true, detail: '' }] };
  assert.equal(summarize([withRule], { minPassRate: 0 }).gate.pass, true);
});
