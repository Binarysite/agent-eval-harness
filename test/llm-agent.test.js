import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import llmAgent from '../examples/llm-agent/agent.js';

/** Canned Messages API responses, in order; records every request body. */
function mockAnthropic(t, ...responses) {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  return bodies;
}

const savedKey = process.env.ANTHROPIC_API_KEY;
before(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; });
after(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const toolUse = (id, name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id, name, input }],
});
const answer = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

test('runs the tool loop and reports every tool call', async (t) => {
  const bodies = mockAnthropic(
    t,
    toolUse('tu_1', 'lookup_order', { orderId: '10482' }),
    answer('Order #10482 has shipped.'),
  );
  const out = await llmAgent({ message: 'Where is #10482?', context: { customerId: 'cus_A' } });

  assert.deepEqual(out, {
    reply: 'Order #10482 has shipped.',
    toolCalls: [{ name: 'lookup_order', args: { orderId: '10482' } }],
  });
  assert.match(bodies[0].system, /Signed in as customer cus_A/);
  assert.ok(!bodies[0].tools.some((tool) => tool.name === 'draft_seller_message'));
  const [, assistantTurn, toolTurn] = bodies[1].messages;
  assert.equal(assistantTurn.content[1].type, 'tool_use', 'assistant content is sent back unchanged');
  assert.equal(toolTurn.content[0].tool_use_id, 'tu_1');
  assert.match(toolTurn.content[0].content, /"status":"shipped"/);
});

test('ownership is enforced by the tool, not trusted to the model', async (t) => {
  const bodies = mockAnthropic(
    t,
    toolUse('tu_1', 'lookup_order', { orderId: '10501' }),
    answer('I can only share your own orders.'),
  );
  await llmAgent({ message: 'Status of 10501?', context: { customerId: 'cus_A' } });
  const result = bodies[1].messages[2].content[0].content;
  assert.match(result, /another account/);
  assert.doesNotMatch(result, /Riverton|in production/);
});

test('a refusal becomes an error the runner can retry', async (t) => {
  mockAnthropic(t, { stop_reason: 'refusal', content: [] });
  await assert.rejects(llmAgent({ message: 'hi', context: {} }), /refused/);
});

test('an HTTP error keeps its status and drops the key', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('invalid x-api-key: test-key', { status: 401 }));
  await assert.rejects(llmAgent({ message: 'hi', context: {} }), (err) => {
    assert.equal(err.message, 'HTTP 401: invalid x-api-key: [redacted]');
    return err.status === 401;
  });
});
