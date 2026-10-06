import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExpectations } from '../src/expectations.js';

const toCall = (n) => (typeof n === 'string' ? { name: n, args: {} } : n);
const out = (reply, ...calls) => ({ reply, toolCalls: calls.map(toCall) });
const failing = (checks) => checks.filter((c) => !c.pass).map((c) => c.rule);

test('tools and noTools check which tools ran', () => {
  const o = out('ok', 'lookup_order');
  assert.deepEqual(failing(checkExpectations({ tools: ['lookup_order'], noTools: ['issue_refund'] }, o)), []);
  assert.deepEqual(failing(checkExpectations({ tools: ['issue_refund'] }, o)), ['tools']);
  assert.deepEqual(failing(checkExpectations({ noTools: ['lookup_order'] }, o)), ['noTools']);
});

test('anyTool works in both directions', () => {
  assert.deepEqual(failing(checkExpectations({ anyTool: true }, out('x'))), ['anyTool']);
  assert.deepEqual(failing(checkExpectations({ anyTool: false }, out('x', 'lookup_order'))), ['anyTool']);
  assert.deepEqual(failing(checkExpectations({ anyTool: false }, out('x'))), []);
});

test('handoff uses the configured handoff tool name', () => {
  const o = out('x', 'escalate');
  assert.deepEqual(failing(checkExpectations({ handoff: true }, o)), ['handoff']);
  assert.deepEqual(failing(checkExpectations({ handoff: true }, o, { handoffTool: 'escalate' })), []);
  assert.deepEqual(failing(checkExpectations({ handoff: false }, o, { handoffTool: 'escalate' })), ['handoff']);
});

test('toolArgs matches a subset of arguments on some call', () => {
  const o = out('x', { name: 'lookup_order', args: { orderId: '10482', verbose: true } });
  assert.deepEqual(failing(checkExpectations({ toolArgs: { lookup_order: { orderId: '10482' } } }, o)), []);
  const bad = checkExpectations({ toolArgs: { lookup_order: { orderId: '99999' } } }, o);
  assert.equal(bad[0].pass, false);
  assert.match(bad[0].detail, /no lookup_order call with/);
});

test('toolArgs compares nested values regardless of key order', () => {
  const o = out('x', { name: 'ship', args: { address: { city: 'Springfield', zip: '00001' } } });
  const expect = { toolArgs: { ship: { address: { zip: '00001', city: 'Springfield' } } } };
  assert.deepEqual(failing(checkExpectations(expect, o)), []);
});

test('text rules are case insensitive and report the offending phrase', () => {
  const o = out('Your order SHIPPED to Springfield');
  assert.deepEqual(failing(checkExpectations({ includesAny: ['shipped', 'delivered'] }, o)), []);
  assert.deepEqual(failing(checkExpectations({ includesAny: ['delivered'] }, o)), ['includesAny']);
  const [ex] = checkExpectations({ excludes: ['springfield'] }, o);
  assert.equal(ex.pass, false);
  assert.match(ex.detail, /"springfield"/);
});

test('an unknown rule fails instead of passing silently', () => {
  const [c] = checkExpectations({ exclude: ['x'] }, out('x'));
  assert.equal(c.pass, false);
  assert.match(c.detail, /unknown expectation/);
});
