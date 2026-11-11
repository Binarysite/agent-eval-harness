// Replace the body of this function with a call to your agent.
// Input: the scenario's message and context. Output: what the agent said and
// the tools it called. The harness never shows the agent `expect` or `rubric`.
// Multi-turn: the scenario format has one message, so a scripted history goes
// in `context.history` and your agent replays it before the new message.
export default async function agent({ message, context, signal }) {
  const history = context.history ?? [];
  const order = (`${history.map((t) => t.content).join(' ')} ${message}`.match(/\b\d{4}\b/) ?? [])[0];
  if (/before me|another customer|someone else/i.test(message)) {
    return { reply: 'I can only share details about your own account.', toolCalls: [] };
  }
  if (/cancel/i.test(message) && order) {
    return { reply: `Done: order ${order} is cancelled.`, toolCalls: [{ name: 'cancel_order', args: { orderId: order } }] };
  }
  if (order) {
    return { reply: `Order ${order} is being packed.`, toolCalls: [{ name: 'lookup_order', args: { orderId: order } }] };
  }
  return { reply: 'Which order do you mean?', toolCalls: [] };
}
