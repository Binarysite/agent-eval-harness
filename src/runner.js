import { checkExpectations } from './expectations.js';

/**
 * @typedef {import('./scenarios.js').Scenario} Scenario
 * @typedef {import('./expectations.js').AgentOutput} AgentOutput
 */

/**
 * The agent under test. It receives one user message and returns what it said
 * plus the tools it called. Everything else (model, prompt, tool execution) is
 * the agent's business, so the harness works with any stack.
 * Throw an Error with a numeric `status` for HTTP failures; 4xx other than 429 is not retried.
 * @callback Agent
 * @param {{ message: string, context: Record<string, unknown>, scenario: Scenario, signal: AbortSignal }} input
 * @returns {Promise<{ reply: string, toolCalls?: Array<{ name: string, args?: object } | string> }>}
 */

/**
 * A judge grades one output against the scenario rubric.
 * `pass: null` means the judge could not decide (bad JSON, refusal, outage).
 * Throw an Error with a numeric `status` for HTTP failures; 4xx other than 429 is not retried.
 * @callback Judge
 * @param {{ scenario: Scenario, output: AgentOutput, signal: AbortSignal }} input
 * @returns {Promise<{ pass: boolean | null, reason: string }>}
 */

/**
 * @typedef {object} CaseResult
 * @property {string} id
 * @property {string} category
 * @property {boolean} critical
 * @property {'pass' | 'fail' | 'error'} status
 * @property {number} attempts
 * @property {number} durationMs
 * @property {AgentOutput | null} output
 * @property {import('./expectations.js').CheckResult[]} checks
 * @property {{ pass: boolean | null, reason: string, attempts: number } | null} verdict
 * @property {string} [error]
 */

/**
 * @typedef {object} RunOptions
 * @property {Agent} agent
 * @property {Judge} [judge]
 * @property {number} [concurrency]  cases in flight at once (default 4)
 * @property {number} [retries]      retries per call on infrastructure failures (default 1)
 * @property {number} [timeoutMs]    per call timeout for agent and judge (default 10000)
 * @property {string} [handoffTool]  tool name the `handoff` rule looks for
 * @property {(r: CaseResult) => void} [onResult]
 */

/** Run `fn` with an AbortSignal and reject if it takes longer than `ms`. */
export async function withTimeout(fn, ms, label = 'call') {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Map with at most `limit` promises in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Accept `toolCalls` as objects or bare names; reject anything else loudly. */
export function normalizeOutput(raw) {
  if (!raw || typeof raw.reply !== 'string') throw new Error('agent must return { reply: string, toolCalls?: [] }');
  const calls = raw.toolCalls ?? [];
  if (!Array.isArray(calls)) throw new Error('agent toolCalls must be an array');
  const toolCalls = calls.map((c, i) => {
    if (typeof c === 'string') return { name: c, args: {} };
    if (!c || typeof c.name !== 'string') {
      throw new Error(`agent toolCalls[${i}] must be a tool name or { name, args }`);
    }
    return { name: c.name, args: c.args ?? {} };
  });
  return { reply: raw.reply, toolCalls };
}

/**
 * A failure is worth retrying when it is the network, a timeout, a 429 or a
 * 5xx. A 4xx such as a bad key or a bad request will fail the same way.
 */
export function isTransient(err) {
  const status = err?.status;
  return typeof status !== 'number' || status === 429 || status >= 500;
}

/** Call `fn` with a timeout, retrying transient failures up to `retries` times. */
async function withRetries(fn, { retries, timeoutMs, label }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { value: await withTimeout(fn, timeoutMs, label), attempts };
    } catch (error) {
      if (attempts > retries || !isTransient(error)) return { error, attempts };
    }
  }
}

const INVALID_VERDICT = 'judge returned an invalid verdict, expected { pass: boolean | null, reason: string }';

/** A verdict that is not `{ pass: boolean | null }` becomes undecided, never a pass. */
function normalizeVerdict(raw) {
  const valid = raw !== null && typeof raw === 'object' && (typeof raw.pass === 'boolean' || raw.pass === null);
  if (!valid) return { pass: null, reason: INVALID_VERDICT };
  return { ...raw, reason: String(raw.reason ?? '') };
}

/** Ask the judge for a verdict; a judge that keeps failing becomes undecided. */
async function judgeCase(judge, scenario, output, opts) {
  const { value, error, attempts } = await withRetries(
    (signal) => judge({ scenario, output, signal }),
    { ...opts, label: 'judge' },
  );
  const verdict = error ? { pass: null, reason: `judge error: ${error.message}` } : normalizeVerdict(value);
  return { ...verdict, attempts };
}

function caseStatus(rulesPass, verdict) {
  if (!rulesPass || verdict?.pass === false) return 'fail';
  if (verdict && verdict.pass !== true) return 'error';
  return 'pass';
}

/**
 * Evaluate one scenario. Only infrastructure failures are retried (network,
 * timeout, 429, 5xx), with the same policy for agent and judge. A wrong answer
 * or a "no" from the judge is never retried: retrying until green hides the
 * flakiness an eval exists to expose. The judge only runs when every rule
 * passed, so you never pay to grade a case that already failed.
 * @param {Scenario} scenario
 * @param {Omit<RunOptions, 'concurrency' | 'onResult'>} opts
 * @returns {Promise<CaseResult>}
 */
export async function runCase(scenario, { agent, judge, retries = 1, timeoutMs = 10_000, handoffTool } = {}) {
  const started = performance.now();
  const base = { id: scenario.id, category: scenario.category, critical: scenario.critical === true };
  const done = (fields) => ({ ...base, ...fields, durationMs: Math.round(performance.now() - started) });

  const { value, error, attempts } = await withRetries(
    (signal) => agent({ message: scenario.message, context: scenario.context ?? {}, scenario, signal }),
    { retries, timeoutMs, label: 'agent' },
  );
  const failed = { attempts, output: null, checks: [], verdict: null, status: 'error' };
  if (error) return done({ ...failed, error: error.message });

  let output;
  let checks;
  try {
    output = normalizeOutput(value);
    checks = checkExpectations(scenario.expect ?? {}, output, { handoffTool });
  } catch (err) {
    return done({ ...failed, error: err.message });
  }

  const rulesPass = checks.every((c) => c.pass);
  const shouldJudge = rulesPass && judge && scenario.rubric;
  const verdict = shouldJudge ? await judgeCase(judge, scenario, output, { retries, timeoutMs }) : null;
  return done({ attempts, output, checks, verdict, status: caseStatus(rulesPass, verdict) });
}

/**
 * Run a scenario bank with bounded concurrency.
 * @param {Scenario[]} scenarios
 * @param {RunOptions} opts
 * @returns {Promise<CaseResult[]>}
 */
export async function runSuite(scenarios, { concurrency = 4, onResult, ...opts }) {
  if (typeof opts.agent !== 'function') throw new TypeError('runSuite needs an agent function');
  return mapLimit(scenarios, concurrency, async (scenario) => {
    const result = await runCase(scenario, opts);
    onResult?.(result);
    return result;
  });
}
