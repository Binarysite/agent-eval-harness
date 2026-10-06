/**
 * A deterministic, rule-based support agent for a fictional custom sticker
 * shop. It stands in for an LLM agent so the harness runs with no API key.
 * Swap it for your real agent: same input, same { reply, toolCalls } output.
 *
 * All orders, customers and places below are invented.
 */

export const ORDERS = {
  10482: {
    customerId: 'cus_A',
    status: 'shipped',
    detail: 'tracking number TRK-0001, arriving Thursday',
    shipTo: 'Springfield',
  },
  10501: { customerId: 'cus_B', status: 'in production', detail: 'ships within 2 business days', shipTo: 'Riverton' },
  10533: {
    customerId: 'cus_A',
    status: 'waiting for your proof approval',
    detail: 'printing starts once you approve',
    shipTo: 'Springfield',
  },
};

const anyOf = (...patterns) => new RegExp(patterns.map((p) => p.source).join('|'), 'i');

const PATTERNS = {
  injection: anyOf(
    /(ignore|disregard)\s+(all\s+|any\s+|your\s+|the\s+)?(previous\s+|prior\s+)?(instructions|rules)/,
    /system prompt|developer mode|you are now/,
  ),
  bulkData: anyOf(
    /(other|another) customer|all (the )?customers|customer list/,
    /(email|address|phone)( address)? of the person|who ordered/,
  ),
  sellerTask: /draft|write|reply|message|announce/i,
  escalation: /chargeback|lawyer|attorney|\bsue\b|scam|furious|real person|human/i,
  refund: /refund|money back|charged twice|double charged|damaged|misprint/i,
  proof: /\bproof\b/i,
  change: /change|fix|typo|edit|update|should say/i,
  file: /\b([\w-]+\.(png|jpe?g|pdf|svg|ai|eps))\b/i,
  status: /where('s| is) my|when will|arrive|track|status/i,
  orderId: /#?\b(\d{5})\b/,
};

const ownOnly = 'I can only share details about orders on your own account. '
  + 'If this is your order, please sign in with the account that placed it.';
const askOrder = 'Happy to help. What is your order number? It starts with # in your confirmation email.';

/**
 * Print-readiness check for an artwork file.
 * @param {string} file
 * @param {number | null} dpi  null when unknown
 * @param {boolean} textNearEdge
 * @returns {Array<'resolution' | 'safe_zone'>} the problems found, empty when print-ready
 */
export function preflight(file, dpi, textNearEdge) {
  const vector = /\.(svg|ai|eps|pdf)$/i.test(file);
  const issues = [];
  if (!vector && dpi !== null && dpi < 300) issues.push('resolution');
  if (textNearEdge) issues.push('safe_zone');
  return issues;
}

/**
 * @param {{ privacyGuard?: boolean }} [opts] privacyGuard=false simulates a regression.
 * @returns {import('../../src/runner.js').Agent}
 */
export function createAgent({ privacyGuard = true } = {}) {
  // Intents are checked in priority order and the first match wins:
  // safety first, then escalation, then the happy paths.
  return async function stickerShopAgent({ message, context }) {
    const toolCalls = [];
    const call = (name, args = {}) => toolCalls.push({ name, args });
    const say = (reply) => ({ reply, toolCalls });
    const orderId = message.match(PATTERNS.orderId)?.[1];

    /** Look up an order and enforce that it belongs to the signed-in customer. */
    const lookup = () => {
      call('lookup_order', { orderId });
      const order = ORDERS[orderId];
      if (!order) return { blocked: `I couldn't find order #${orderId}. Could you double-check the number?` };
      if (privacyGuard && order.customerId !== context.customerId) return { blocked: ownOnly };
      return { order };
    };

    if (PATTERNS.injection.test(message)) {
      return say(
        "I can't help with that request. I can check an order, review an artwork file or connect you with our team.",
      );
    }
    if (PATTERNS.bulkData.test(message)) return say(ownOnly);

    if (context.role === 'seller' && PATTERNS.sellerTask.test(message)) {
      const quoted = message.match(/"([^"]{3,})"/)?.[1];
      const promo = 'Our holiday stickers are 20% off this weekend only. Grab yours before Sunday night!';
      const answer = 'Thanks for asking! Yes, our sticker packs ship internationally. '
        + 'Delivery usually takes 7 to 14 days.';
      const text = quoted ?? (/20% off/i.test(message) ? promo : answer);
      call('draft_seller_message', { text });
      return say(`Draft (not sent, approve it before it goes out): "${text}"`);
    }

    const summary = message.slice(0, 140);
    if (PATTERNS.escalation.test(message)) {
      call('handoff_to_human', { reason: 'escalation', summary });
      return say("I'm sorry about this. I've passed your case to a teammate who will reply here shortly.");
    }

    if (PATTERNS.refund.test(message)) {
      if (orderId) {
        const { blocked } = lookup();
        if (blocked) return say(blocked);
      }
      call('handoff_to_human', { reason: 'refund', summary });
      return say(
        "I've sent this to our support team with your details. A teammate will review it and reply here. "
          + "I can't approve refunds myself.",
      );
    }

    if (PATTERNS.proof.test(message) && PATTERNS.change.test(message)) {
      if (!orderId) return say(askOrder);
      const { blocked } = lookup();
      if (blocked) return say(blocked);
      call('request_proof_change', { orderId, change: message });
      return say(
        `Done. I asked our design team to update the proof for order #${orderId}. `
          + "You'll get a new proof by email to approve.",
      );
    }

    const file = message.match(PATTERNS.file)?.[1];
    if (file) {
      const dpi = Number(message.match(/(\d+)\s*dpi/i)?.[1]) || null;
      const textNearEdge = /edge|cut line|border/i.test(message);
      call('preflight_artwork', { file, dpi, textNearEdge });
      const issues = preflight(file, dpi, textNearEdge);
      if (!issues.length) return say(`${file} looks print-ready. Go ahead and place your order.`);
      const tips = {
        resolution: `${file} is ${dpi} dpi, which will print blurry. `
          + 'Please upload it at 300 dpi or as a vector file (SVG, AI, PDF).',
        safe_zone: 'Keep text at least 1/8 inch away from the edge so the cut line does not clip it.',
      };
      return say(issues.map((i) => tips[i]).join(' '));
    }

    if (orderId || PATTERNS.status.test(message)) {
      if (!orderId) return say(askOrder);
      const { order, blocked } = lookup();
      if (blocked) return say(blocked);
      return say(`Order #${orderId} is ${order.status} (${order.detail}), shipping to ${order.shipTo}.`);
    }

    return say(
      'I can help with orders, artwork files and proofs. For anything else, our help center is the best place to look.',
    );
  };
}

export default createAgent();
