/**
 * The same agent with the order ownership check turned off. The flag
 * (`privacyGuard: false`) simulates the kind of refactor that drops one guard:
 * everything still works for the customer's own orders, so the pass rate
 * barely moves. The critical gate is what catches it.
 *
 *   npm run eval:regression
 */
import { createAgent } from './agent.js';

export default createAgent({ privacyGuard: false });
