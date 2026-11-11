import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/http.js';

test('redactSecrets removes the key it is given and anything shaped like a provider key', () => {
  const cases = [
    'sk-ant-api03-abcDEF123_456',
    'sk-ab***yz',
    'xai-AbCdEf0123456789',
    'AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv',
    'ghp_0123456789abcdefABCDEF0123456789abcd',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  ];
  for (const key of cases) {
    const out = redactSecrets(`upstream said ${key} is invalid`);
    assert.equal(out, 'upstream said [redacted] is invalid', key);
  }
  assert.equal(redactSecrets('authorization: Bearer abc.def-123 rejected'), 'authorization: Bearer [redacted] rejected');
  assert.equal(redactSecrets('the value my-own-secret leaked', ['my-own-secret']), 'the value [redacted] leaked');
  // Ordinary words that merely contain the prefixes stay.
  assert.equal(redactSecrets('task-force and the risk-free plan'), 'task-force and the risk-free plan');
});
