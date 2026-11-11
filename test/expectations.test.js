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

test('text rules see through zero-width characters, soft hyphens and fullwidth letters', () => {
  for (const reply of [
    'Order is in pro​duction',
    'Order is in pro­duction',
    'Order is in ｐｒｏｄｕｃｔｉｏｎ',
    'Order is in PRO⁠DUCTION',
    'Order is in pro﻿duction',
  ]) {
    assert.deepEqual(failing(checkExpectations({ excludes: ['in production'] }, out(reply))), ['excludes'], JSON.stringify(reply));
    assert.deepEqual(failing(checkExpectations({ includesAny: ['in production'] }, out(reply))), [], JSON.stringify(reply));
  }
  // The phrase is normalized too, so a fullwidth phrase matches a plain reply.
  assert.deepEqual(failing(checkExpectations({ excludes: ['Ｒiverton'] }, out('shipping to Riverton'))), ['excludes']);
});

test('an invisible character between a letter and its accent cannot split the phrase', () => {
  // Dropping invisibles only after NFKC left "e" + U+0301 uncomposed, so "café" missed.
  for (const [name, mark] of Object.entries({
    'combining grapheme joiner U+034F': '\u034F',
    'zero width joiner U+200D': '\u200D',
    'tag characters U+E0001 U+E0041': '\u{E0001}\u{E0041}',
    'zero width space U+200B': '\u200B',
  })) {
    for (const [phrase, reply] of [
      ['café', `Meet me at the cafe${mark}\u0301`],
      ['devolución', `Su devolucio${mark}\u0301n está lista`],
      ['DEVOLUCIÓN', `su devolucio${mark}${mark}\u0301n`],
    ]) {
      assert.deepEqual(failing(checkExpectations({ excludes: [phrase] }, out(reply))), ['excludes'], `${name}: ${phrase}`);
      assert.deepEqual(failing(checkExpectations({ includesAny: [phrase] }, out(reply))), [], `${name}: ${phrase}`);
    }
  }
  // The decomposed phrase matches a precomposed reply too.
  assert.deepEqual(failing(checkExpectations({ excludes: ['cafe\u0301'] }, out('a café'))), ['excludes']);
});

test('blank characters that are not whitespace or are wide fillers read as a space', () => {
  for (const [name, reply] of Object.entries({
    'next line U+0085': 'full\u0085refund',
    'braille blank U+2800': 'full\u2800refund',
    'Hangul filler U+3164 as a space': 'full\u3164refund',
    'halfwidth Hangul filler U+FFA0': 'full\uFFA0refund',
    'Hangul choseong filler U+115F': 'full\u115Frefund',
    'Hangul jungseong filler U+1160': 'full\u1160refund',
  })) {
    assert.deepEqual(failing(checkExpectations({ excludes: ['full refund'] }, out(`a ${reply}`))), ['excludes'], name);
    assert.deepEqual(failing(checkExpectations({ includesAny: ['full refund'] }, out(`a ${reply}`))), [], name);
  }
  // Inside a word a filler still reads as nothing, as before.
  assert.deepEqual(failing(checkExpectations({ excludes: ['full refund'] }, out('a fu\u3164ll refund'))), ['excludes']);
});

test('look-alike letters from another script are a known limit, not folded', () => {
  // Cyrillic U+0435 for a Latin "e": documented in SECURITY.md and the README Limits.
  assert.deepEqual(failing(checkExpectations({ excludes: ['full refund'] }, out('full r\u0435fund'))), []);
});

test('text rules ignore every default-ignorable character and fold whitespace', () => {
  const cases = {
    'left-to-right mark U+200E': 'in pro‎duction',
    'right-to-left override U+202E': 'in pro‮duction',
    'tag characters U+E0070 U+E0072': 'in pro\u{E0070}\u{E0072}duction',
    'combining grapheme joiner U+034F': 'in pro͏duction',
    'variation selector-16 U+FE0F': 'in pro️duction',
    'Mongolian vowel separator U+180E': 'in pro᠎duction',
    'invisible times U+2062': 'in pro⁢duction',
    'Hangul filler U+3164': 'in proㅤduction',
    'a line break': 'in\nproduction',
    'a double space': 'in  production',
    'a no-break space and a tab': 'in \tproduction',
  };
  for (const [name, reply] of Object.entries(cases)) {
    assert.deepEqual(failing(checkExpectations({ excludes: ['in production'] }, out(`Order is ${reply}`))), ['excludes'], name);
    assert.deepEqual(failing(checkExpectations({ includesAny: ['in production'] }, out(`Order is ${reply}`))), [], name);
  }
  // The phrase is folded the same way, so a phrase with a line break matches a plain reply.
  assert.deepEqual(failing(checkExpectations({ excludes: ['in\nproduction'] }, out('Order is in production'))), ['excludes']);
});
