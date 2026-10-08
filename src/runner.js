import { setTimeout as sleep } from 'node:timers/promises';
import { checkExpectations } from './expectations.js';

/**
 * @typedef {import('./scenarios.js').Scenario} Scenario
 * @typedef {import('./expectations.js').AgentOutput} AgentOutput
 */

/**
 * The agent under test. It receives one user message and returns what it said
 * plus the tools it called. Everything else (model, prompt, tool execution) is
 * the agent's business, so the harness works with any stack.
 * It never sees expect or rubric: an agent that can read the answers would
 * grade itself.
 * Throw an Error with a numeric `status` for HTTP failures; 4xx other than 429 is
 * not retried. Set `retryable: false` on an error that would repeat (a refusal).
 * A retry calls the agent again from scratch, tool calls included.
 * @callback Agent
 * @param {{ message: string, context: Record<string, unknown>, signal: AbortSignal }} input
 * @returns {Promise<{ reply: string, toolCalls?: Array<{ name: string, args?: object } | string> }>}
 */

/**
 * A judge grades one output against the scenario rubric.
 * `pass: null` means the judge could not decide (bad JSON, refusal, outage).
 * `graded: false` means it did not read the rubric (the mock judge); omitted means it did.
 * Throw an Error with a numeric `status` for HTTP failures; 4xx other than 429 is not retried.
 * @callback Judge
 * @param {{ scenario: Scenario, output: AgentOutput, signal: AbortSignal }} input
 * @returns {Promise<{ pass: boolean | null, reason: string, graded?: boolean }>}
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
 * @property {{ pass: boolean | null, reason: string, graded: boolean, attempts: number } | null} verdict
 *   `graded: false` when no judge read the rubric (mock judge, or no judge at all)
 * @property {string} [error]
 * @property {{ run: number, passed: number }} [trials]  set by runSuite
 * @property {boolean} [flaky]  set by runSuite: the trials did not all end the same way
 */

/**
 * @typedef {object} RunOptions
 * @property {Agent} agent
 * @property {Judge} [judge]
 * @property {number} [concurrency]  cases in flight at once (default 4)
 * @property {number} [trials]       times each case runs (default 1); see combineTrials
 * @property {number} [retries]      retries per call on infrastructure failures (default 1)
 * @property {number} [timeoutMs]    per call timeout for agent and judge (default 10000)
 * @property {number} [retryDelayMs] base of the exponential backoff between retries (default 500)
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
      reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { name: 'TimeoutError' }));
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

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/**
 * A failure is worth retrying when it is infrastructure: the network, an abort
 * or timeout, a 429 or a 5xx. Anything else (a 4xx, a refusal, max_tokens, a
 * bug in the agent) would fail the same way again, so it is reported at once.
 */
export function isTransient(err) {
  if (err?.retryable === false) return false;
  const status = err?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  // fetch reports network failures as `TypeError: fetch failed` with the code on `cause`.
  return NETWORK_CODES.has(err?.code) || NETWORK_CODES.has(err?.cause?.code)
    || (err instanceof TypeError && err.message === 'fetch failed');
}

const MAX_BACKOFF_MS = 8_000;
// A longer Retry-After would stall the whole run; past this the retry is
// attempted anyway and reported if it fails again.
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * How long to wait before retry number `attempt`: the server's Retry-After
 * when the error carries one (`retryAfterMs`), otherwise exponential backoff
 * with full jitter, so parallel cases that hit the same 429 do not retry in
 * lockstep.
 */
export function retryDelay(err, attempt, baseMs = 500) {
  if (Number.isFinite(err?.retryAfterMs)) return Math.min(Math.max(0, err.retryAfterMs), MAX_RETRY_AFTER_MS);
  return Math.random() * Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (attempt - 1));
}

/** Call `fn` with a timeout, retrying transient failures up to `retries` times. */
async function withRetries(fn, { retries, timeoutMs, retryDelayMs, label }) {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { value: await withTimeout(fn, timeoutMs, label), attempts };
    } catch (error) {
      if (attempts > retries || !isTransient(error)) return { error, attempts };
      await sleep(retryDelay(error, attempts, retryDelayMs));
    }
  }
}

const INVALID_VERDICT = 'judge returned an invalid verdict, expected { pass: boolean | null, reason: string }';

/** A verdict that is not `{ pass: boolean | null }` becomes undecided, never a pass. */
function normalizeVerdict(raw) {
  const valid = raw !== null && typeof raw === 'object' && (typeof raw.pass === 'boolean' || raw.pass === null);
  if (!valid) return { pass: null, reason: INVALID_VERDICT, graded: false };
  return { ...raw, reason: String(raw.reason ?? ''), graded: raw.graded !== false };
}

/** Recorded when a case has a rubric but the run has no judge. It never decides the status. */
const NOT_GRADED = Object.freeze({ pass: null, reason: 'rubric not graded: no judge', graded: false, attempts: 0 });

/** Ask the judge for a verdict; a judge that keeps failing becomes undecided. */
async function judgeCase(judge, scenario, output, opts) {
  const { value, error, attempts } = await withRetries(
    (signal) => judge({ scenario, output, signal }),
    { ...opts, label: 'judge' },
  );
  const verdict = error
    ? { pass: null, reason: `judge error: ${error.message}`, graded: false }
    : normalizeVerdict(value);
  return { ...verdict, attempts };
}

function caseStatus(rulesPass, verdict) {
  if (!rulesPass || verdict?.pass === false) return 'fail';
  if (verdict && verdict.pass !== true) return 'error';
  return 'pass';
}

/**
 * Evaluate one scenario. Only infrastructure failures are retried (network,
 * abort, timeout, 429, 5xx), with the same policy for agent and judge. A wrong answer
 * or a "no" from the judge is never retried: retrying until green hides the
 * flakiness an eval exists to expose. The judge only runs when every rule
 * passed, so you never pay to grade a case that already failed.
 * @param {Scenario} scenario
 * @param {Omit<RunOptions, 'concurrency' | 'onResult'>} opts
 * @returns {Promise<CaseResult>}
 */
export async function runCase(
  scenario,
  { agent, judge, retries = 1, timeoutMs = 10_000, retryDelayMs = 500, handoffTool } = /** @type {any} */ ({}),
) {
  const started = performance.now();
  const base = { id: scenario.id, category: scenario.category, critical: scenario.critical === true };
  const done = (fields) => ({ ...base, ...fields, durationMs: Math.round(performance.now() - started) });

  const { value, error, attempts } = await withRetries(
    (signal) => agent({ message: scenario.message, context: scenario.context ?? {}, signal }),
    { retries, timeoutMs, retryDelayMs, label: 'agent' },
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
  const finish = (verdict, status) => done({ attempts, output, checks, verdict, status });
  if (!rulesPass || !scenario.rubric) return finish(null, caseStatus(rulesPass, null));
  if (!judge) return finish({ ...NOT_GRADED }, 'pass');
  const verdict = await judgeCase(judge, scenario, output, { retries, timeoutMs, retryDelayMs });
  return finish(verdict, caseStatus(rulesPass, verdict));
}

/**
 * Fold the trials of one case into one result. A case is flaky when its trials
 * did not all end with the same status. A critical case passes only if every
 * trial passed; any other case needs a strict majority. The output, checks and
 * verdict shown are those of the first trial that agrees with the outcome.
 * @param {CaseResult[]} runs
 * @returns {CaseResult}
 */
export function combineTrials(runs) {
  const passed = runs.filter((r) => r.status === 'pass').length;
  const needed = runs[0].critical ? runs.length : Math.floor(runs.length / 2) + 1;
  const pass = passed >= needed;
  const shown = runs.find((r) => (r.status === 'pass') === pass);
  return {
    ...shown,
    durationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
    trials: { run: runs.length, passed },
    flaky: new Set(runs.map((r) => r.status)).size > 1,
  };
}

/**
 * Run a scenario bank with bounded concurrency, each case `trials` times in a row.
 * @param {Scenario[]} scenarios
 * @param {RunOptions} opts
 * @returns {Promise<CaseResult[]>}
 */
export async function runSuite(scenarios, { concurrency = 4, trials = 1, onResult, ...opts }) {
  if (typeof opts.agent !== 'function') throw new TypeError('runSuite needs an agent function');
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('trials must be a positive integer');
  return mapLimit(scenarios, concurrency, async (scenario) => {
    const runs = [];
    for (let i = 0; i < trials; i += 1) runs.push(await runCase(scenario, opts));
    const result = combineTrials(runs);
    onResult?.(result);
    return result;
  });
}
