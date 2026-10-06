import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCase, runSuite, normalizeOutput, isTransient } from '../src/runner.js';

const scenario = (extra = {}) => ({ id: 's1', category: 'c', message: 'hi', expect: { anyTool: false }, ...extra });
const okAgent = async () => ({ reply: 'hello', toolCalls: [] });

test('a passing case records output, checks and attempts', async () => {
  const r = await runCase(scenario(), { agent: okAgent });
  assert.equal(r.status, 'pass');
  assert.equal(r.attempts, 1);
  assert.equal(r.output.reply, 'hello');
  assert.ok(r.checks.every((c) => c.pass));
});

test('the agent receives message, context and an abort signal', async () => {
  let seen;
  await runCase(scenario({ context: { customerId: 'u1' } }), {
    agent: async (input) => { seen = input; return { reply: 'x' }; },
  });
  assert.equal(seen.message, 'hi');
  assert.deepEqual(seen.context, { customerId: 'u1' });
  assert.ok(seen.signal instanceof AbortSignal);
});

test('throws are retried, then reported as errors', async () => {
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error('503'); return { reply: 'ok' }; };
  const r = await runCase(scenario(), { agent: flaky, retries: 1 });
  assert.equal(r.status, 'pass');
  assert.equal(r.attempts, 2);

  const broken = await runCase(scenario(), { agent: async () => { throw new Error('down'); }, retries: 2 });
  assert.equal(broken.status, 'error');
  assert.equal(broken.attempts, 3);
  assert.equal(broken.error, 'down');
});

test('a slow agent times out and the signal is aborted', async () => {
  let signal;
  const slow = (input) => { signal = input.signal; return new Promise(() => {}); };
  const r = await runCase(scenario(), { agent: slow, timeoutMs: 20, retries: 0 });
  assert.equal(r.status, 'error');
  assert.match(r.error, /timed out after 20 ms/);
  assert.equal(signal.aborted, true);
});

test('a wrong answer is a failure and is never retried', async () => {
  let calls = 0;
  const wrong = async () => { calls += 1; return { reply: 'x', toolCalls: ['issue_refund'] }; };
  const r = await runCase(scenario(), { agent: wrong, retries: 3 });
  assert.equal(r.status, 'fail');
  assert.equal(calls, 1);
});

test('malformed agent output is an error, not a crash', async () => {
  const r = await runCase(scenario(), { agent: async () => ({ text: 'oops' }), retries: 0 });
  assert.equal(r.status, 'error');
  assert.match(r.error, /reply: string/);
});

test('normalizeOutput accepts bare tool names and rejects malformed calls', () => {
  assert.deepEqual(normalizeOutput({ reply: 'x', toolCalls: ['a'] }).toolCalls, [{ name: 'a', args: {} }]);
  assert.deepEqual(normalizeOutput({ reply: 'x' }).toolCalls, []);
  assert.throws(() => normalizeOutput({ reply: 'x', toolCalls: 'a' }), /must be an array/);
  assert.throws(() => normalizeOutput({ reply: 'x', toolCalls: [null] }), /toolCalls\[0\] must be a tool name/);
});

test('isTransient retries the network, 429 and 5xx, but not other 4xx', () => {
  const cases = [[undefined, true], [429, true], [500, true], [401, false], [400, false]];
  for (const [status, expected] of cases) {
    assert.equal(isTransient(Object.assign(new Error('x'), { status })), expected, String(status));
  }
});

test('an agent that hangs once is retried and answers on the second attempt', async () => {
  let calls = 0;
  const hangsOnce = () => {
    calls += 1;
    return calls === 1 ? new Promise(() => {}) : Promise.resolve({ reply: 'ok' });
  };
  const r = await runCase(scenario(), { agent: hangsOnce, timeoutMs: 20, retries: 1 });
  assert.equal(r.status, 'pass');
  assert.equal(r.attempts, 2);
});

test('an agent HTTP 401 is not retried', async () => {
  let calls = 0;
  const denied = async () => { calls += 1; throw Object.assign(new Error('HTTP 401: invalid key'), { status: 401 }); };
  const r = await runCase(scenario(), { agent: denied, retries: 3 });
  assert.equal(r.status, 'error');
  assert.equal(calls, 1);
});

test('the judge runs only when rules pass and a rubric exists', async () => {
  let judged = 0;
  const judge = async () => { judged += 1; return { pass: false, reason: 'missed the point' }; };
  const withRubric = scenario({ rubric: 'answer the question' });

  const r = await runCase(withRubric, { agent: okAgent, judge });
  assert.equal(r.status, 'fail');
  assert.equal(r.verdict.reason, 'missed the point');

  await runCase(scenario(), { agent: okAgent, judge });
  await runCase(withRubric, { agent: async () => ({ reply: 'x', toolCalls: ['t'] }), judge });
  assert.equal(judged, 1);
});

test('an undecided or crashing judge marks the case as error', async () => {
  const s = scenario({ rubric: 'r' });
  const unsure = await runCase(s, { agent: okAgent, judge: async () => ({ pass: null, reason: 'bad json' }) });
  assert.equal(unsure.status, 'error');
  const crash = await runCase(s, { agent: okAgent, judge: async () => { throw new Error('429'); } });
  assert.equal(crash.status, 'error');
  assert.match(crash.verdict.reason, /429/);
});

test('a judge that returns undefined is an error after one call, not an endless loop', async () => {
  let calls = 0;
  const silent = async () => { calls += 1; };
  const r = await runCase(scenario({ rubric: 'r' }), { agent: okAgent, judge: silent, retries: 3 });
  assert.equal(r.status, 'error');
  assert.equal(calls, 1);
  assert.match(r.verdict.reason, /invalid verdict/);
});

test('a judge verdict without a boolean pass is an error, never a pass', async () => {
  for (const bad of [{}, { pass: 'false' }]) {
    const r = await runCase(scenario({ rubric: 'r' }), { agent: okAgent, judge: async () => bad });
    assert.equal(r.status, 'error', JSON.stringify(bad));
  }
});

test('a judge that times out marks the case as error', async () => {
  const r = await runCase(scenario({ rubric: 'r' }), {
    agent: okAgent, judge: () => new Promise(() => {}), timeoutMs: 20, retries: 0,
  });
  assert.equal(r.status, 'error');
  assert.match(r.verdict.reason, /timed out/);
});

test('transient judge errors are retried, a bad request is not', async () => {
  const s = scenario({ rubric: 'r' });
  let calls = 0;
  const hiccup = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('HTTP 429: slow down'), { status: 429 });
    return { pass: true, reason: 'ok' };
  };
  const r = await runCase(s, { agent: okAgent, judge: hiccup, retries: 1 });
  assert.equal(r.status, 'pass');
  assert.equal(r.verdict.attempts, 2);

  calls = 0;
  const badKey = async () => { calls += 1; throw Object.assign(new Error('HTTP 401: invalid key'), { status: 401 }); };
  const denied = await runCase(s, { agent: okAgent, judge: badKey, retries: 3 });
  assert.equal(denied.status, 'error');
  assert.equal(calls, 1);
  assert.equal(denied.verdict.attempts, 1);

  calls = 0;
  const no = async () => { calls += 1; return { pass: false, reason: 'missed it' }; };
  assert.equal((await runCase(s, { agent: okAgent, judge: no, retries: 3 })).status, 'fail');
  assert.equal(calls, 1, 'a "no" from the judge is an answer, not a hiccup');
});

test('runSuite keeps input order and never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const agent = async ({ scenario: s }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + (Number(s.id) % 3) * 5));
    inFlight -= 1;
    return { reply: s.id };
  };
  const bank = Array.from({ length: 10 }, (_, i) => scenario({ id: String(i) }));
  const seen = [];
  const results = await runSuite(bank, { agent, concurrency: 3, onResult: (r) => seen.push(r.id) });
  assert.equal(peak, 3);
  assert.deepEqual(results.map((r) => r.output.reply), bank.map((s) => s.id));
  assert.equal(seen.length, 10);
});

test('runSuite rejects a missing agent', async () => {
  await assert.rejects(runSuite([], {}), /needs an agent/);
});
