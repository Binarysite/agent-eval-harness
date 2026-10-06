import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockJudge } from '../src/judges/mock.js';
import {
  parseVerdict,
  buildJudgePrompt,
  createAnthropicJudge,
  createOpenAICompatibleJudge,
  JUDGE_SYSTEM,
} from '../src/judges/llm.js';
import { runSuite } from '../src/runner.js';
import { summarize, buildReport } from '../src/report.js';

const output = (reply, toolCalls = []) => ({ reply, toolCalls });
const scenario = { id: 's', category: 'c', message: 'refund me', rubric: 'hand off', critical: true };

test('mock judge is deterministic and explains every verdict', async () => {
  const judge = createMockJudge({ maxChars: 40 });
  assert.deepEqual(await judge({ scenario, output: output('A teammate will reply here.') }), {
    pass: true,
    reason: 'mock heuristics passed (rubric not graded)',
  });
  assert.equal((await judge({ scenario, output: output('   ') })).reason, 'empty reply');
  assert.match((await judge({ scenario, output: output('x'.repeat(41)) })).reason, /41 chars, limit 40/);
  assert.match((await judge({ scenario, output: output('We GUARANTEE a refund') })).reason, /"guarantee"/);
});

test('parseVerdict extracts JSON from chatty output', () => {
  const chatty = 'Sure! {"pass": true, "reason": "handed off"} done';
  assert.deepEqual(parseVerdict(chatty), { pass: true, reason: 'handed off' });
  assert.deepEqual(parseVerdict('{"pass": false}'), { pass: false, reason: '' });
});

test('parseVerdict never turns garbage into a pass', () => {
  assert.equal(parseVerdict('looks good to me').pass, null);
  assert.equal(parseVerdict('{"pass": "yes"}').pass, null);
});

test('judge prompt includes rubric, reply, tool calls and the critical flag', () => {
  const p = buildJudgePrompt(scenario, output('ok', [{ name: 'handoff_to_human', args: { reason: 'refund' } }]));
  assert.match(p, /Rubric: hand off/);
  assert.match(p, /Agent reply: "ok"/);
  assert.match(p, /handoff_to_human\({"reason":"refund"}\)/);
  assert.match(p, /safety-critical/);
});

test('LLM adapters refuse to start without credentials', () => {
  assert.throws(() => createAnthropicJudge({ apiKey: '' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => createOpenAICompatibleJudge({ apiKey: '' }), /OPENAI_API_KEY/);
  assert.throws(() => createOpenAICompatibleJudge({ apiKey: 'k', model: '' }), /JUDGE_MODEL/);
});

/** Replace fetch with a queue of canned responses and record every request. */
function mockFetch(t, ...responses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const { status = 200, body } = responses.shift();
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return calls;
}

const KEY = 'test-key-do-not-leak';
const anthropicText = (text, extra = {}) => ({
  body: { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra },
});
const openAIText = (content) => ({ body: { choices: [{ message: { content } }] } });

test('Anthropic judge sends the rubric and parses the verdict', async (t) => {
  const calls = mockFetch(t, anthropicText('{"pass": false, "reason": "promised a refund"}'));
  const judge = createAnthropicJudge({ apiKey: KEY, model: 'judge-model' });
  const verdict = await judge({ scenario, output: output('Refund issued!') });
  assert.deepEqual(verdict, { pass: false, reason: 'promised a refund' });
  const [req] = calls;
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], KEY);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.model, 'judge-model');
  assert.equal(req.body.system, JUDGE_SYSTEM);
  assert.match(req.body.messages[0].content, /Rubric: hand off/);
});

test('Anthropic judge: refusal and unparseable text are undecided, HTTP errors carry the status', async (t) => {
  mockFetch(
    t,
    anthropicText('', { content: [], stop_reason: 'refusal' }),
    anthropicText('I think it passed'),
    { status: 429, body: 'rate limited' },
  );
  const judge = createAnthropicJudge({ apiKey: KEY });
  assert.deepEqual(await judge({ scenario, output: output('x') }), { pass: null, reason: 'judge refused to grade' });
  assert.equal((await judge({ scenario, output: output('x') })).pass, null);
  await assert.rejects(
    judge({ scenario, output: output('x') }),
    (err) => err.status === 429 && /HTTP 429: rate limited/.test(err.message),
  );
});

test('HTTP error messages never carry the key, raw or masked', async (t) => {
  mockFetch(t, { status: 401, body: `Incorrect API key provided: ${KEY}. Also seen as sk-ab***yz.` });
  const judge = createOpenAICompatibleJudge({ apiKey: KEY, model: 'm' });
  await assert.rejects(judge({ scenario, output: output('x') }), (err) => {
    assert.equal(err.message, 'HTTP 401: Incorrect API key provided: [redacted]. Also seen as [redacted].');
    return err.status === 401;
  });
});

test('OpenAI-compatible judge honours the base URL and handles errors', async (t) => {
  const calls = mockFetch(
    t,
    openAIText('{"pass": true, "reason": "handed off"}'),
    openAIText('not json'),
    { status: 503, body: 'down' },
  );
  const judge = createOpenAICompatibleJudge({ apiKey: KEY, model: 'grok-x', baseUrl: 'https://api.x.ai/v1/' });
  assert.deepEqual(await judge({ scenario, output: output('x') }), { pass: true, reason: 'handed off' });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal((await judge({ scenario, output: output('x') })).pass, null);
  await assert.rejects(judge({ scenario, output: output('x') }), (err) => err.status === 503);
});

test('the API key never reaches the report', async (t) => {
  mockFetch(t, anthropicText('{"pass": true, "reason": "ok"}'), { status: 401, body: 'invalid x-api-key' });
  const judge = createAnthropicJudge({ apiKey: KEY });
  const agent = async () => ({ reply: 'A teammate will reply.', toolCalls: ['handoff_to_human'] });
  const bank = [{ ...scenario, id: 'a' }, { ...scenario, id: 'b' }];
  const results = await runSuite(bank, { agent, judge, concurrency: 1, retries: 0 });
  assert.deepEqual(results.map((r) => r.status), ['pass', 'error']);
  assert.ok(!JSON.stringify(buildReport(results, summarize(results))).includes(KEY));
});
